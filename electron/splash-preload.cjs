// Gives the splash screen its calls into the main process (electron/main.js): joining the early access list,
// and holding the app back until the sign up form is answered
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("psqlcarbon", {
	joinEarlyAccess: (email) => ipcRenderer.invoke("splash:join-early-access", email),
	hold: (hold) => ipcRenderer.send("splash:hold", Boolean(hold)),
});
