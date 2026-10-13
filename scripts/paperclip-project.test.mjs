import assert from "node:assert/strict";
import test from "node:test";
import {
  createApi,
  ensureProject,
  readEnvValue,
} from "./paperclip-project.mjs";

test("credential parsing supports LF, CRLF and quoted values without evaluating shell", () => {
  for (const newline of ["\n", "\r\n"]) {
    assert.equal(
      readEnvValue(
        `OTHER=x${newline}TOKEN='literal$(value)'${newline}`,
        "TOKEN",
      ),
      "literal$(value)",
    );
    assert.throws(() => readEnvValue("OTHER=x", "TOKEN"), /missing TOKEN/);
  }
});

test("registration resumes after a failed workspace creation and creates no duplicates", async () => {
  const projects = [];
  const workspaces = [];
  let fail = true;
  let projectCreates = 0;
  const api = async (route, body) => {
    if (route.endsWith("/agents"))
      return [{ id: "lead", metadata: { developer_worker: "opencode" } }];
    if (route.endsWith("/projects")) {
      if (!body) return projects;
      projectCreates++;
      const project = { id: "project", ...body };
      projects.push(project);
      return project;
    }
    if (!body) return workspaces;
    if (fail) {
      fail = false;
      throw new Error("interrupted");
    }
    const workspace = { id: "workspace", ...body };
    workspaces.push(workspace);
    return workspace;
  };
  const input = {
    api,
    companyId: "company",
    name: "Dyad",
    repoUrl: "https://example.com/dyad.git",
    description: "Source",
  };
  await assert.rejects(ensureProject(input), /interrupted/);
  const state = await ensureProject(input);
  assert.deepEqual(await ensureProject(input), state);
  assert.equal(projectCreates, 1);
  assert.equal(workspaces.length, 1);
  assert.equal(projects[0].leadAgentId, "lead");
});

test("registration requires the existing developer roster before creating a project", async () => {
  await assert.rejects(
    ensureProject({ api: async () => [], companyId: "company", name: "Dyad" }),
    /no OpenCode/,
  );
});

test("API errors omit private response bodies and credentials", async () => {
  const api = createApi("http://localhost/api", "private-key", async () => ({
    ok: false,
    status: 403,
    json: () => ({ secret: "private-body" }),
  }));
  await assert.rejects(api("/projects", {}), (error) => {
    assert.equal(error.message, "POST /projects returned HTTP 403");
    return true;
  });
});
