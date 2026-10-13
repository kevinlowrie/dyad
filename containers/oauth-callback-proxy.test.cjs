const assert = require("node:assert/strict");
const net = require("node:net");
const test = require("node:test");
const { createOAuthCallbackProxy } = require("./oauth-callback-proxy.cjs");

test("forwards a host-browser callback to the app loopback listener", async (t) => {
  const backend = net.createServer((socket) => socket.pipe(socket));
  await new Promise((resolve) => backend.listen(0, "127.0.0.1", resolve));
  const backendPort = backend.address().port;
  const proxy = createOAuthCallbackProxy({
    host: "127.0.0.1",
    port: 0,
    targetPort: backendPort,
  });
  await new Promise((resolve) => proxy.once("listening", resolve));
  t.after(async () => {
    await Promise.all(
      [backend, proxy].map(
        (server) => new Promise((resolve) => server.close(resolve)),
      ),
    );
  });

  const received = new Promise((resolve, reject) => {
    const client = net.connect(proxy.address().port, "127.0.0.1", () => {
      client.write("GET /auth/callback?code=test HTTP/1.1\r\n\r\n");
    });
    client.setEncoding("utf8");
    client.once("data", (data) => {
      client.destroy();
      resolve(data);
    });
    client.on("error", reject);
  });
  assert.match(await received, /GET \/auth\/callback\?code=test/);
});
