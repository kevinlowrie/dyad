import fs from "node:fs";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

export function createOpenUriServer(openUrl) {
  return http.createServer((request, response) => {
    if (
      request.method !== "POST" ||
      !new Set(["/", "/dyad"]).has(request.url)
    ) {
      response.writeHead(404).end();
      return;
    }

    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 8192) request.destroy();
    });
    request.on("end", () => {
      let url;
      try {
        url = new URL(body);
      } catch {
        response.writeHead(400).end("Invalid URL");
        return;
      }
      const dyadPrompt = request.url === "/dyad";
      if (dyadPrompt ? !isDyadPromptUrl(url) : !isBrowserUrl(url)) {
        response
          .writeHead(400)
          .end(
            dyadPrompt
              ? "Only validated Dyad add-prompt links are allowed"
              : "Only credential-free HTTP(S) URLs are allowed",
          );
        return;
      }

      openUrl(url.href, (error) => {
        if (error) {
          response.writeHead(502).end("Host browser could not be opened");
          return;
        }
        response
          .writeHead(202)
          .end(dyadPrompt ? "Opened in Dyad" : "Opened in host browser");
      });
    });
  });
}

function isBrowserUrl(url) {
  return (
    new Set(["http:", "https:"]).has(url.protocol) &&
    !url.username &&
    !url.password
  );
}

function isDyadPromptUrl(url) {
  if (
    url.protocol !== "dyad:" ||
    url.hostname !== "add-prompt" ||
    (url.pathname !== "" && url.pathname !== "/") ||
    url.username ||
    url.password ||
    url.port ||
    url.hash ||
    [...url.searchParams.keys()].some((key) => key !== "data")
  ) {
    return false;
  }
  const encoded = url.searchParams.get("data") ?? "";
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      encoded,
    )
  ) {
    return false;
  }
  try {
    const decoded = Buffer.from(encoded, "base64").toString("utf8");
    if (Buffer.from(decoded, "utf8").toString("base64") !== encoded)
      return false;
    const payload = JSON.parse(decoded);
    return (
      payload &&
      typeof payload === "object" &&
      !Array.isArray(payload) &&
      Object.keys(payload).every((key) =>
        ["title", "description", "content"].includes(key),
      ) &&
      ["title", "description", "content"].every(
        (key) =>
          typeof payload[key] === "string" && payload[key].length <= 6000,
      ) &&
      payload.title.length > 0 &&
      payload.content.length > 0 &&
      Buffer.byteLength(decoded, "utf8") <= 7000
    );
  } catch {
    return false;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const socketPath = process.argv[2];
  if (!socketPath) throw new Error("Expected a Unix socket path");
  fs.rmSync(socketPath, { force: true });

  const server = createOpenUriServer((url, done) => {
    const opener = spawn("/usr/bin/xdg-open", [url], {
      detached: true,
      stdio: "ignore",
    });
    opener.once("error", done);
    opener.once("spawn", () => {
      opener.unref();
      done();
    });
  });

  server.listen(socketPath, () => {
    fs.chmodSync(socketPath, 0o666);
  });

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () =>
      server.close(() => fs.rmSync(socketPath, { force: true })),
    );
  }
}
