"""Port adapter for upstream Blenderwright 2.3.x; its MCP protocol is unchanged."""
import argparse
import sys

parser = argparse.ArgumentParser()
parser.add_argument("--repo", required=True)
parser.add_argument("--port", type=int, required=True)
args = parser.parse_args()
sys.path.insert(0, args.repo + "/src")
from blenderwright.connection import BlenderConnection
import blenderwright.server as upstream

upstream._connection = BlenderConnection(host="127.0.0.1", port=args.port)
sys.argv = ["blenderwright"]
upstream.main()
