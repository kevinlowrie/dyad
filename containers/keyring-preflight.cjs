const { app, safeStorage } = require("electron");

app.setName("dyad");
app.setPath("userData", "/tmp/dyad-keyring-preflight");

app.whenReady().then(() => {
  const backend = safeStorage.getSelectedStorageBackend();
  if (backend !== "gnome_libsecret" || !safeStorage.isEncryptionAvailable()) {
    throw new Error(
      `GNOME keyring encryption is unavailable (selected backend: ${backend})`,
    );
  }

  const check = "dyad-keyring-preflight";
  const encrypted = safeStorage.encryptString(check);
  if (safeStorage.decryptString(encrypted) !== check) {
    throw new Error("GNOME keyring encryption round trip failed");
  }

  console.log("GNOME keyring encryption is available.");
  app.quit();
}).catch((error) => {
  console.error(error.message);
  app.exit(1);
});
