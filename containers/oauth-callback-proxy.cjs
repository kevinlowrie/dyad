const net = require("node:net");

function createOAuthCallbackProxy({
  host = "0.0.0.0",
  port = 1456,
  targetHost = "127.0.0.1",
  targetPort = 1455,
} = {}) {
  return net.createServer((client) => {
    const upstream = net.connect({ host: targetHost, port: targetPort });
    client.pipe(upstream);
    upstream.pipe(client);
    client.on("error", () => upstream.destroy());
    upstream.on("error", () => client.destroy());
  }).listen(port, host);
}

if (require.main === module) {
  createOAuthCallbackProxy();
}

module.exports = { createOAuthCallbackProxy };
