"use strict";

const {
	app,
	BrowserWindow,
	Notification,
	dialog,
	session,
	shell,
} = require("electron");
const {
	appendFileSync,
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	writeSync,
} = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const { spawn } = require("node:child_process");

const APP_NAME = "FiveCut";
const APP_ID = "app.fivecut.FiveCut";
const isSmokeTest = process.argv.includes("--smoke-test");
if (isSmokeTest) app.disableHardwareAcceleration();

let mainWindow = null;
let serverProcess = null;
let serverLogPath = null;

function findServerScript() {
	const webRoot = path.join(__dirname, "web");
	const candidates = [
		path.join(webRoot, "apps", "web", "server.js"),
		path.join(webRoot, "server.js"),
	];
	const serverScript = candidates.find((candidate) => existsSync(candidate));
	if (!serverScript) {
		throw new Error(
			`The bundled FiveCut server is missing. Checked:\n${candidates.join("\n")}`,
		);
	}
	return serverScript;
}

async function reservePort() {
	return await new Promise((resolve, reject) => {
		const server = net.createServer();
		server.unref();
		server.once("error", reject);
		server.listen({ host: "127.0.0.1", port: 0 }, () => {
			const address = server.address();
			const port =
				typeof address === "object" && address ? address.port : null;
			server.close((error) => {
				if (error) reject(error);
				else if (port === null) reject(new Error("Could not reserve a port."));
				else resolve(port);
			});
		});
	});
}

function startServer({ port }) {
	const serverScript = findServerScript();
	const logDirectory = app.getPath("logs");
	mkdirSync(logDirectory, { recursive: true });
	serverLogPath = path.join(logDirectory, "fivecut-server.log");
	const serverLogDescriptor = openSync(serverLogPath, "a");
	writeSync(
		serverLogDescriptor,
		`\n--- FiveCut ${new Date().toISOString()} ---\n`,
	);
	try {
		serverProcess = spawn(process.execPath, [serverScript], {
			cwd: path.dirname(serverScript),
			env: {
				...process.env,
				ELECTRON_RUN_AS_NODE: "1",
				FIVECUT_OFFLINE: "1",
				HOSTNAME: "127.0.0.1",
				NEXT_TELEMETRY_DISABLED: "1",
				NODE_ENV: "production",
				PORT: String(port),
			},
			stdio: ["ignore", serverLogDescriptor, serverLogDescriptor],
			windowsHide: true,
		});
	} finally {
		closeSync(serverLogDescriptor);
	}

	serverProcess.once("error", (error) => {
		if (serverLogPath) {
			appendFileSync(
				serverLogPath,
				`Server process error: ${error.stack ?? error}\n`,
			);
		}
	});
	return serverProcess;
}

async function waitForServer({ port, timeoutMs = 45_000 }) {
	const startedAt = Date.now();
	const url = `http://127.0.0.1:${port}/projects`;

	while (Date.now() - startedAt < timeoutMs) {
		if (serverProcess?.exitCode !== null) {
			throw new Error(
				`The local FiveCut server exited with code ${serverProcess?.exitCode}.`,
			);
		}

		const ready = await new Promise((resolve) => {
			const request = http.get(url, (response) => {
				response.resume();
				resolve(
					response.statusCode !== undefined && response.statusCode < 500,
				);
			});
			request.setTimeout(1_000, () => request.destroy());
			request.once("error", () => resolve(false));
		});
		if (ready) return url;
		await new Promise((resolve) => setTimeout(resolve, 150));
	}

	throw new Error("FiveCut did not finish starting within 45 seconds.");
}

function uniqueDownloadPath(filename) {
	const parsed = path.parse(path.basename(filename || "fivecut-export.mp4"));
	let candidate = path.join(app.getPath("downloads"), parsed.base);
	let counter = 1;
	while (existsSync(candidate)) {
		candidate = path.join(
			app.getPath("downloads"),
			`${parsed.name} (${counter})${parsed.ext}`,
		);
		counter += 1;
	}
	return candidate;
}

function configureSession() {
	const appSession = session.defaultSession;
	appSession.setPermissionRequestHandler((_webContents, permission, callback) => {
		callback(permission === "clipboard-read" || permission === "media");
	});
	appSession.on("will-download", (_event, item) => {
		const destination = uniqueDownloadPath(item.getFilename());
		item.setSavePath(destination);
		item.once("done", (_downloadEvent, state) => {
			if (state !== "completed" || isSmokeTest) return;
			const notification = new Notification({
				title: "FiveCut export finished",
				body: `Saved to ${destination}`,
			});
			notification.on("click", () => shell.showItemInFolder(destination));
			notification.show();
		});
	});
}

function createWindow({ editorUrl }) {
	const iconPath = path.join(__dirname, "icon.svg");
	mainWindow = new BrowserWindow({
		title: APP_NAME,
		width: 1440,
		height: 900,
		minWidth: 1024,
		minHeight: 640,
		backgroundColor: "#0b0b0c",
		icon: existsSync(iconPath) ? iconPath : undefined,
		show: false,
		webPreferences: {
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
			spellcheck: true,
		},
	});

	const allowedOrigin = new URL(editorUrl).origin;
	const isAllowedUrl = (url) => {
		try {
			return new URL(url).origin === allowedOrigin;
		} catch {
			return false;
		}
	};
	const openExternalUrl = (url) => {
		try {
			const protocol = new URL(url).protocol;
			if (protocol === "https:" || protocol === "http:") {
				void shell.openExternal(url);
			}
		} catch {
			// Ignore malformed or unsafe external navigation targets.
		}
	};
	mainWindow.webContents.setWindowOpenHandler(({ url }) => {
		if (isAllowedUrl(url)) void mainWindow.loadURL(url);
		else openExternalUrl(url);
		return { action: "deny" };
	});
	mainWindow.webContents.on("will-navigate", (event, url) => {
		if (isAllowedUrl(url)) return;
		event.preventDefault();
		openExternalUrl(url);
	});
	mainWindow.webContents.on(
		"did-fail-load",
		(_event, code, description, validatedUrl, isMainFrame) => {
			if (!isMainFrame || code === -3) return;
			failStartup(
				new Error(
					`Could not load ${validatedUrl}: ${description} (error ${code})`,
				),
			);
		},
	);

	mainWindow.once("ready-to-show", () => {
		if (!isSmokeTest) {
			mainWindow?.maximize();
			mainWindow?.show();
		}
	});
	mainWindow.on("closed", () => {
		mainWindow = null;
	});

	if (isSmokeTest) {
		const smokeTimeout = setTimeout(() => {
			failStartup(new Error("Desktop smoke test timed out."));
		}, 45_000);
		mainWindow.webContents.once("did-finish-load", async () => {
			try {
				const result = await mainWindow.webContents.executeJavaScript(`
					({
						title: document.title,
						text: document.body.innerText.slice(0, 4000),
						url: location.href
					})
				`);
				if (!result.text.includes("FiveCut")) {
					throw new Error(
						`FiveCut branding was not found in the loaded page: ${JSON.stringify(result)}`,
					);
				}
				clearTimeout(smokeTimeout);
				process.stdout.write(
					`FiveCut desktop smoke test passed: ${result.url}\n`,
				);
				stopServer();
				app.exit(0);
			} catch (error) {
				clearTimeout(smokeTimeout);
				failStartup(error);
			}
		});
	}

	void mainWindow.loadURL(editorUrl);
}

function stopServer() {
	if (serverProcess && serverProcess.exitCode === null) {
		serverProcess.kill("SIGTERM");
		const processToStop = serverProcess;
		const killTimer = setTimeout(() => {
			if (processToStop.exitCode === null) processToStop.kill("SIGKILL");
		}, 3_000);
		killTimer.unref();
	}
	serverProcess = null;
}

function failStartup(error) {
	const message = error instanceof Error ? error.message : String(error);
	process.stderr.write(`FiveCut failed to start: ${message}\n`);
	if (!isSmokeTest && app.isReady()) {
		dialog.showErrorBox(
			"FiveCut could not start",
			`${message}\n\nServer logs: ${path.join(app.getPath("logs"), "fivecut-server.log")}`,
		);
	}
	stopServer();
	app.exit(1);
}

async function launch() {
	app.setAppUserModelId(APP_ID);
	app.setAppLogsPath();
	configureSession();
	const port = await reservePort();
	startServer({ port });
	const editorUrl = await waitForServer({ port });
	createWindow({ editorUrl });
}

app.setName(APP_NAME);

if (!app.requestSingleInstanceLock()) {
	app.quit();
} else {
	app.on("second-instance", () => {
		if (!mainWindow) return;
		if (mainWindow.isMinimized()) mainWindow.restore();
		mainWindow.show();
		mainWindow.focus();
	});
	app.on("before-quit", stopServer);
	app.on("window-all-closed", () => app.quit());
	app.whenReady().then(launch).catch(failStartup);
}
