import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

export function readEnvValue(contents, name) {
  const line = contents.split(/\r?\n/).find((value) =>
    value.startsWith(`${name}=`),
  );
  let value = line?.slice(name.length + 1).trim();
  if (value && /^(["']).*\1$/.test(value)) value = value.slice(1, -1);
  if (!value) throw new Error(`Credential file is missing ${name}`);
  return value;
}

export function createApi(base, key, fetchImpl = fetch) {
  return async (route, body, method = body ? "POST" : "GET") => {
    const response = await fetchImpl(`${base.replace(/\/$/, "")}${route}`, {
      method,
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    // Response bodies can contain private adapter configuration. Keep failures
    // useful without dumping credentials or upstream responses into logs.
    if (!response.ok) {
      throw new Error(`${method} ${route} returned HTTP ${response.status}`);
    }
    return response.json();
  };
}

export async function ensureProject({ api, companyId, name, repoUrl, description }) {
  const projects = await api(`/companies/${companyId}/projects`);
  let project = projects.find((item) => item.name === name);
  if (!project) {
    const agents = await api(`/companies/${companyId}/agents`);
    const lead = agents.find(
      (agent) => agent.metadata?.developer_worker === "opencode",
    );
    if (!lead) throw new Error("The company has no OpenCode Developer Team agent");
    project = await api(`/companies/${companyId}/projects`, {
      name,
      description,
      status: "in_progress",
      leadAgentId: lead.id,
    });
  }
  const workspaces = await api(`/projects/${project.id}/workspaces`);
  let workspace = workspaces.find((item) => item.repoUrl === repoUrl);
  if (!workspace) {
    workspace = await api(`/projects/${project.id}/workspaces`, {
      name: "Dyad source",
      repoUrl,
      repoRef: "main",
      isPrimary: workspaces.length === 0,
    });
  }
  return { companyId, projectId: project.id, workspaceId: workspace.id };
}

async function main() {
  const action = process.argv[2];
  if (!["sync", "submit", "status"].includes(action)) {
    console.log(
      "Usage: node scripts/paperclip-project.mjs sync | submit <scope> <prompt-file> [request-uuid] | status <job-uuid>",
    );
    return;
  }
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const privateDir = process.env.PAPERCLIP_CREDENTIAL_DIR ??
    path.join(os.homedir(), ".config/homelab/agent-workers");
  const stateFile = path.join(root, "userData/paperclip-project.json");
  if (action === "sync") {
    const key = readEnvValue(
      await fs.readFile(path.join(privateDir, "paperclip.env"), "utf8"),
      "PAPERCLIP_API_KEY",
    );
    const api = createApi(process.env.PAPERCLIP_API_URL ?? "http://127.0.0.1:3100/api", key);
    const identity = await api("/agents/me");
    const companyId = process.env.PAPERCLIP_COMPANY_ID ?? identity.companyId;
    if (!companyId) throw new Error("Set PAPERCLIP_COMPANY_ID for this credential");
    const state = await ensureProject({
      api,
      companyId,
      name: process.env.PAPERCLIP_PROJECT_NAME ?? "Dyad",
      repoUrl: "https://github.com/dyad-sh/dyad.git",
      description: [
        "Dyad Electron AI app builder, maintained by the existing Developer Team.",
        "Desktop: http://127.0.0.1:6080/vnc.html?autoconnect=1&resize=remote",
        "Node 24; React 19; Vite/Electron Forge; SQLite/Drizzle; Vitest/Playwright.",
        "Worker repository slug: dyad. Seed: homelab/.state/agent-workers/repos/dyad.",
        "Host checkout: " + root,
        "See docs/local-podman.md and AGENTS.md. Preserve the Electron IPC boundary.",
        "Submit through the Developer Team coordinator with repo=dyad and this project_id.",
        "Workers lack internet and Podman access; report unavailable build dependencies explicitly.",
      ].join("\n"),
    });
    await fs.mkdir(path.dirname(stateFile), { recursive: true });
    await fs.writeFile(stateFile, JSON.stringify(state, null, 2) + "\n");
    console.log(JSON.stringify(state, null, 2));
    return;
  }
  const key = readEnvValue(
    await fs.readFile(path.join(privateDir, "team.env"), "utf8"),
    "WORKER_API_KEY",
  );
  const api = createApi(process.env.PAPERCLIP_TEAM_URL ?? "http://127.0.0.1:8110", key);
  if (action === "status") {
    const jobId = process.argv[3];
    if (!/^[0-9a-f-]{36}$/i.test(jobId ?? "")) throw new Error("A job UUID is required");
    console.log(JSON.stringify(await api(`/v1/jobs/${jobId}`), null, 2));
    return;
  }
  const [, , , scope, promptFile, requestId] = process.argv;
  if (!["research", "plan", "small-code", "complex-code", "qa"].includes(scope) || !promptFile) {
    throw new Error("Supply a supported scope and a prompt file");
  }
  const state = JSON.parse(await fs.readFile(stateFile, "utf8"));
  const body = {
    scope,
    prompt: await fs.readFile(promptFile, "utf8"),
    repo: "dyad",
    project_id: state.projectId,
    memory_namespace: "dyad",
    request_id: requestId ?? randomUUID(),
    project_requirements: [
      "Read AGENTS.md, CONTRIBUTING.md, and relevant rules before editing.",
      "Use Node 24 or 25, npm run ts, npm run lint, and the pinned oxfmt.",
      "Use the narrowest regression test; feature work requires RED/GREEN evidence.",
      "Keep proposed changes in the isolated checkout and return reviewable patches.",
    ],
  };
  console.log(JSON.stringify({ request_id: body.request_id }));
  console.log(JSON.stringify(await api("/v1/jobs", body), null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
