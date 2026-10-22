import { busyStates, questionAnswers } from './plan.mjs';
import { requireQuestions } from './compatibility.mjs';
import { digest } from './store.mjs';

export const interviewGuide = `
入口行为：
1. 一句话普通建模请求，先生成基础模型与真实样例，再问特别需求、是否精细化；不先长篇盘问。
2. 明确存在特别需求时，先进行 grill-me 式访谈。把需求当作决策树，只问前置条件已清楚的问题。
3. 每轮选择最影响结果的 1—3 个问题，给简短推荐选项，等待用户回答；已回答事实不得重复问。
4. 硬件、项目、软件版本和素材基本信息由工具读取，不让用户代查。
5. 先明确用途、主体、风格、精度含义，再追问结构、材质、参考还原、动作、摄影机、音乐、交付规格。
6. 精度含义区分视觉细节、参考图一致性、真实尺寸/装配；不能把高面数当作全部要求。
7. 用户可以说不确定、跳过、按推荐；把这些标为已声明的默认值，不编造用户决定。
8. 关键分歧解决后提交简短需求摘要供用户确认，再生成样例；摘要确认不等于样例批准。
9. 读取现有 grilling 和媒体技能作方法参考，但它们不能扩大下载、收费、上传、检查或正式生成授权。
`;

export async function askRound(ctx, store, projectId, exec, questions) {
  requireQuestions(ctx);
  if (!Array.isArray(questions) || questions.length < 1 || questions.length > 3) throw new Error('每轮需要 1—3 个关键问题。');
  const p = await store.load(projectId, exec.agent.id);
  if (busyStates.has(p.state)) throw new Error('制作进行中，请先取消再改变需求。');
  const ids = new Set();
  for (const q of questions) {
    if (!q.id || ids.has(q.id) || !q.question || Object.hasOwn(p.requirements, q.id)) throw new Error('问题编号重复、缺少问题，或正在重复询问已确认的需求。');
    ids.add(q.id);
  }
  const answer = await ctx.userQuestions.ask({ questions, agent: exec.agent, signal: exec.signal });
  const saved = await store.update(projectId, exec.agent.id, current => {
    if (current.revision !== p.revision || busyStates.has(current.state)) throw new Error('项目在访谈期间发生变化；本轮答案未覆盖新需求。');
    current.interview.push({ at: new Date().toISOString(), questions, answer });
    for (const item of answer.answers || []) {
      if (ids.has(item.id) && (item.custom || item.selected?.length)) current.requirements[item.id] = item.custom || item.selected;
    }
    current.state = 'interviewing'; current.approval = null; current.requirementsConfirmed = false;
    return current;
  });
  return { answers: answer.answers, requirements: saved.requirements, next: '根据答案计算下一轮待解决问题；不要重问。关键需求完整后调用 studio_confirm_requirements。' };
}

export async function confirmRequirements(ctx, store, id, summary, exec) {
  requireQuestions(ctx);
  const p = await store.load(id, exec.agent.id);
  const requirementsFingerprint = digest(p.requirements);
  if (busyStates.has(p.state) || !summary?.trim()) throw new Error('需要可确认的需求摘要，且项目不能正在制作。');
  const label = '按这份需求制作样例';
  const result = await ctx.userQuestions.ask({ agent: exec.agent, signal: exec.signal, questions: [{
    id: 'requirements', header: '需求确认', question: '以下理解是否准确？', detail: summary,
    options: [{ label, description: '只确认需求，仍会先展示样例。' }, { label: '继续调整需求', description: '补充或修正当前理解。' }],
  }] });
  const accepted = questionAnswers(result, 'requirements', label);
  await store.update(id, exec.agent.id, current => {
    if (current.revision !== p.revision || busyStates.has(current.state) || digest(current.requirements) !== requirementsFingerprint) throw new Error('需求已变化，不能确认旧摘要。');
    current.requirementsSummary = summary; current.requirementsConfirmed = accepted; current.approval = null;
    current.state = accepted ? 'draft' : 'interviewing'; return current;
  });
  return { accepted, answer: result };
}
