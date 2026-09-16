# reference-mcp

Reference integrity for AI agents. Scans a repository for every reference, URLs, imports, assets, and dependencies, then verifies each one resolves. Catches the dead link, the missing import, and the removed package before an agent acts on them.

Built as an MCP server, so it works in any platform that speaks Model Context Protocol.

## Why

Agents assume references resolve. They import a file that was renamed, link a repo that was deleted, or depend on a package that was unpublished, and only discover it after wasting a session. Reference finds the broken references up front.

## Tools

* `reference.scan` extract every reference from a repository, deduplicated by kind
* `reference.check` verify local paths against the filesystem, module names against the npm registry, and URLs over HTTP. Returns findings with a status per reference and a `BROKEN_REFERENCES` or `ALL_OK` verdict.

Reference kinds: `local` relative imports, `module` npm dependencies, `url` web links, `asset` images and static files.

## Usage

```bash
npm install -g reference-mcp
```

```json
{
  "mcpServers": {
    "reference": {
      "command": "reference-mcp",
      "args": []
    }
  }
}
```

## License

MIT. Part of the Tawakkul Labs MCP family.