"""Only obtains an explicitly approved public upstream snapshot. No credentials."""
import sys
from huggingface_hub import snapshot_download

if __name__ == "__main__":
    snapshot_download(repo_id=sys.argv[1], local_dir=sys.argv[2], token=False)
