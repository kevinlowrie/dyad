import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import test from "node:test";
import { createOpenUriServer } from "./podman-open-uri.mjs";

test("host browser bridge opens credential-free HTTP(S) URLs", async () => {
  const socketPath = path.join(
    os.tmpdir(),
    `dyad-open-uri-${process.pid}-${Date.now()}.sock`,
  );
  const opened = [];
  const server = createOpenUriServer((url, done) => {
    opened.push(url);
    done();
  });
  server.listen(socketPath);
  await once(server, "listening");

  const post = (body) =>
    new Promise((resolve, reject) => {
      const request = http.request(
        { socketPath, path: "/", method: "POST" },
        (response) => {
          response.resume();
          response.on("end", () => resolve(response.statusCode));
        },
      );
      request.on("error", reject);
      request.end(body);
    });

  try {
    assert.equal(
      await post("https://auth.openai.com/oauth/authorize?state=safe"),
      202,
    );
    assert.equal(await post("file:///etc/passwd"), 400);
    assert.deepEqual(opened, [
      "https://auth.openai.com/oauth/authorize?state=safe",
    ]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(socketPath, { force: true });
  }
});

test("Dyad bridge opens only bounded add-prompt deep links", async () => {
  const socketPath = path.join(
    os.tmpdir(),
    `dyad-open-uri-${process.pid}-${Date.now()}.sock`,
  );
  const opened = [];
  const server = createOpenUriServer((url, done) => {
    opened.push(url);
    done();
  });
  server.listen(socketPath);
  await once(server, "listening");

  const post = (pathname, body) =>
    new Promise((resolve, reject) => {
      const request = http.request(
        { socketPath, path: pathname, method: "POST" },
        (response) => {
          response.resume();
          response.on("end", () => resolve(response.statusCode));
        },
      );
      request.on("error", reject);
      request.end(body);
    });

  try {
    const payload = Buffer.from(
      JSON.stringify({
        title: "Customer prototype",
        description: "Brief",
        content: "Create a wireframe",
      }),
    ).toString("base64");
    const uri = `dyad://add-prompt?data=${encodeURIComponent(payload)}`;
    assert.equal(await post("/dyad", uri), 202);
    assert.equal(
      await post("/dyad", "dyad://add-mcp-server?data=eyJ4IjoieSJ9"),
      400,
    );
    assert.equal(
      await post("/dyad", "dyad://add-prompt?data=eyJ0aXRsZSI6Im9rIn0="),
      400,
    );
    assert.equal(
      await post(
        "/dyad",
        "dyad://add-prompt?data=eyJ0aXRsZSI6Im9rIiwiY29udGVudCI6IngifQ==&extra=x",
      ),
      400,
    );
    assert.deepEqual(opened, [uri]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(socketPath, { force: true });
  }
});
