#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { dirname, join, resolve, extname } from "node:path";
import { execSync } from "node:child_process";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const server = new McpServer({ name: pkg.name, version: pkg.version });

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", ".astro", ".next", ".logbook", "coverage", "build", ".netlify", ".dart_tool", ".pub-cache", ".gradle", ".idea", ".vscode", ".cache", "bundle", "release", "Pods"]);
const TEXT_EXT = new Set([".js", ".ts", ".jsx", ".tsx", ".mjs", ".cjs", ".astro", ".html", ".md", ".json", ".yml", ".yaml", ".css", ".py", ".rs", ".go", ".dart", ".vue", ".svelte", ".txt"]);

function walk(dir, out = [], depth = 0) {
  if (depth > 12) return out;
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out, depth + 1);
    else if (TEXT_EXT.has(extname(e.name))) out.push(p);
  }
  return out;
}

const URL_RE = /https?:\/\/[^\s"'<>)\]]+/g;
const IMPORT_RE = /(?:from|import|require)\s*\(?\s*['"]([^'"]+)['"]/g;
const LOCAL_PATH_RE = /['"]([.][^'"\s]+)['"]|href=["']([^"']+)["']|src=["']([^"']+)["']/g;

function classifyImport(value) {
  if (value.startsWith(".") || value.startsWith("/")) return { kind: "local", value };
  if (value.startsWith("node:")) return null;
  return { kind: "module", value };
}

function collectReferences(file) {
  const text = readFileSync(file, "utf8");
  const refs = [];
  const add = (kind, value) => refs.push({ kind, value });
  if (file.endsWith("package.json")) {
    try {
      const pkg = JSON.parse(text);
      for (const group of ["dependencies", "devDependencies", "peerDependencies"]) {
        if (pkg[group]) for (const name of Object.keys(pkg[group])) add("module", name);
      }
      return refs;
    } catch {
      /* not a package manifest */
    }
  }
  for (const m of text.matchAll(URL_RE)) add("url", m[0].replace(/[),.;]+$/, ""));
  for (const m of text.matchAll(IMPORT_RE)) {
    const c = classifyImport(m[1]);
    if (c) add(c.kind, c.value);
  }
  for (const m of text.matchAll(LOCAL_PATH_RE)) {
    const v = m[1] || m[2] || m[3];
    if (v && (v.startsWith(".") || v.startsWith("/") || /\.(png|jpg|jpeg|svg|gif|webp|pdf|css|js|woff2?|json)$/i.test(v))) add("asset", v);
  }
  return refs;
}

function unique(refs) {
  const seen = new Set();
  return refs.filter((r) => {
    const k = r.kind + "|" + r.value;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

async function checkLocal(root, value, sourceFile) {
  let p = value.startsWith("/") ? join(root, value) : resolve(dirname(sourceFile), value);
  if (!existsSync(p)) {
    const fromRoot = join(root, value.replace(/^\//, ""));
    if (existsSync(fromRoot)) p = fromRoot;
    else {
      try {
        const match = execSync(`find "${root}" -type f -name "${basenameName(value)}" 2>/dev/null | head -1`, { encoding: "utf8", maxBuffer: 1 << 20 }).trim();
        if (match) p = match;
      } catch {
        /* no match */
      }
    }
  }
  return { resolved: existsSync(p), path: p };
}

function basenameName(value) {
  const base = value.split("/").pop();
  return base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function checkUrl(url) {
  try {
    const res = await fetch(url, { method: "HEAD", redirect: "follow", signal: AbortSignal.timeout(12000), headers: { "user-agent": "reference-mcp/0.1.0" } });
    return res.status >= 200 && res.status < 400;
  } catch {
    return null;
  }
}

async function checkNpm(name) {
  try {
    const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}`, { method: "HEAD", signal: AbortSignal.timeout(12000) });
    return res.status === 200;
  } catch {
    return null;
  }
}

server.registerTool(
  "reference.scan",
  {
    description: "Scan a repository and extract every reference: URLs, local imports, assets, and module dependencies. Returns a deduplicated list by kind.",
    inputSchema: {
      path: z.string().optional().describe("Repository root. Defaults to the current directory."),
    },
  },
  async ({ path }) => {
    const root = resolve(path || ".");
    const files = walk(root);
    const collected = [];
    for (const f of files) {
      try {
        for (const r of collectReferences(f)) collected.push({ ...r, file: f });
      } catch {
        /* unreadable */
      }
    }
    const kinds = {};
    for (const r of collected) kinds[r.kind] = (kinds[r.kind] || 0) + 1;
    return { content: [{ type: "text", text: JSON.stringify({ root, filesScanned: files.length, references: unique(collected).slice(0, 500), kinds }, null, 2) }] };
  }
);

server.registerTool(
  "reference.check",
  {
    description: "Verify the references in a repository. Local paths are checked against the filesystem, module names against the npm registry, and URLs over HTTP. Returns findings with a status per reference.",
    inputSchema: {
      path: z.string().optional().describe("Repository root. Defaults to the current directory."),
      checkRemote: z.boolean().default(true).describe("Whether to check remote URLs over the network"),
    },
  },
  async ({ path, checkRemote }) => {
    const root = resolve(path || ".");
    const files = walk(root);
    const refs = unique(files.flatMap((f) => {
      try {
        return collectReferences(f).map((r) => ({ ...r, file: f }));
      } catch {
        return [];
      }
    }));
    const findings = [];
    const MAX = 300;
    const subset = refs.slice(0, MAX);
    for (const r of subset) {
      if (r.kind === "local") {
        const c = await checkLocal(root, r.value, r.file);
        findings.push({ kind: r.kind, value: r.value, file: r.file, status: c.resolved ? "ok" : "broken", resolvedTo: c.resolved ? c.path : null });
      } else if (r.kind === "asset") {
        if (r.value.startsWith("http")) {
          if (checkRemote) {
            const ok = await checkUrl(r.value);
            findings.push({ kind: "url", value: r.value, file: r.file, status: ok === null ? "unknown" : ok ? "ok" : "broken" });
          }
        } else {
          const c = await checkLocal(root, r.value, r.file);
          findings.push({ kind: r.kind, value: r.value, file: r.file, status: c.resolved ? "ok" : "broken" });
        }
      } else if (r.kind === "module" && checkRemote) {
        const ok = await checkNpm(r.value);
        findings.push({ kind: r.kind, value: r.value, file: r.file, status: ok === null ? "unknown" : ok ? "ok" : "broken" });
      } else if (r.kind === "url" && checkRemote) {
        const ok = await checkUrl(r.value);
        findings.push({ kind: r.kind, value: r.value, file: r.file, status: ok === null ? "unknown" : ok ? "ok" : "broken" });
      }
    }
    const broken = findings.filter((f) => f.status === "broken");
    const counts = findings.reduce((a, f) => ((a[f.status] = (a[f.status] || 0) + 1), a), {});
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              root,
              total: refs.length,
              checked: findings.length,
              truncated: refs.length > MAX,
              counts,
              findings: findings.slice(0, MAX),
              broken,
              verdict: broken.length ? "BROKEN_REFERENCES" : "ALL_OK",
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);