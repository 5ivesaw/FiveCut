const FALLBACK_RELEASE = {
	tag: "v0.1.0",
	publishedAt: "2026-07-26T09:30:08Z",
	downloadUrl:
		"https://github.com/5ivesaw/FiveCut/releases/download/v0.1.0/FiveCut-linux-x64.tar.gz",
	checksumUrl:
		"https://github.com/5ivesaw/FiveCut/releases/download/v0.1.0/FiveCut-linux-x64.tar.gz.sha256",
	size: 178_694_142,
	releaseUrl: "https://github.com/5ivesaw/FiveCut/releases/tag/v0.1.0",
};

const RELEASE_API =
	"https://api.github.com/repos/5ivesaw/FiveCut/releases/latest";

function formatBytes(bytes) {
	if (!Number.isFinite(bytes) || bytes <= 0) return "170 MB";
	const megabytes = bytes / 1024 / 1024;
	return `${megabytes >= 100 ? Math.round(megabytes) : megabytes.toFixed(1)} MB`;
}

function formatDate(value) {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return "July 2026";

	return new Intl.DateTimeFormat(undefined, {
		month: "short",
		day: "numeric",
		year: "numeric",
	}).format(date);
}

function setText(selector, text) {
	document.querySelectorAll(selector).forEach((element) => {
		element.textContent = text;
	});
}

function setHref(selector, href) {
	document.querySelectorAll(selector).forEach((element) => {
		element.href = href;
	});
}

function applyRelease(release) {
	const shortVersion = release.tag.startsWith("v")
		? release.tag
		: `v${release.tag}`;

	setText("[data-version]", `FiveCut ${shortVersion}`);
	setText("[data-version-short]", shortVersion);
	setText("[data-asset-size]", formatBytes(release.size));
	setText("[data-published]", formatDate(release.publishedAt));
	setHref("[data-download-url]", release.downloadUrl);
	setHref("[data-checksum-url]", release.checksumUrl);
	setHref("[data-release-link]", release.releaseUrl);
}

async function hydrateLatestRelease() {
	applyRelease(FALLBACK_RELEASE);

	try {
		const response = await fetch(RELEASE_API, {
			headers: { Accept: "application/vnd.github+json" },
		});

		if (!response.ok) return;

		const data = await response.json();
		const archive = data.assets?.find(
			(asset) => asset.name === "FiveCut-linux-x64.tar.gz",
		);
		const checksum = data.assets?.find(
			(asset) => asset.name === "FiveCut-linux-x64.tar.gz.sha256",
		);

		if (!archive) return;

		applyRelease({
			tag: data.tag_name || FALLBACK_RELEASE.tag,
			publishedAt: data.published_at || FALLBACK_RELEASE.publishedAt,
			downloadUrl: archive.browser_download_url,
			checksumUrl:
				checksum?.browser_download_url || FALLBACK_RELEASE.checksumUrl,
			size: archive.size,
			releaseUrl: data.html_url || FALLBACK_RELEASE.releaseUrl,
		});
	} catch {
		// The hard-coded release remains usable if GitHub is blocked or offline.
	}
}

function describePlatform() {
	const platform =
		navigator.userAgentData?.platform ||
		navigator.platform ||
		navigator.userAgent ||
		"";
	const label = document.querySelector("[data-download-label]");

	if (!label) return;

	if (/linux/i.test(platform)) {
		label.textContent = "Download for Linux";
	} else if (/win/i.test(platform)) {
		label.textContent = "Get the Linux build";
		label.title = "Windows support is on the roadmap";
	} else if (/mac|iphone|ipad/i.test(platform)) {
		label.textContent = "Get the Linux build";
		label.title = "macOS support is on the roadmap";
	}
}

function setupNavigation() {
	const header = document.querySelector("[data-header]");
	const toggle = document.querySelector("[data-menu-toggle]");
	const menu = document.querySelector("[data-menu]");

	const updateHeader = () => {
		header?.classList.toggle("is-scrolled", window.scrollY > 12);
	};

	updateHeader();
	window.addEventListener("scroll", updateHeader, { passive: true });

	if (!toggle || !menu) return;

	const close = () => {
		toggle.setAttribute("aria-expanded", "false");
		menu.classList.remove("is-open");
	};

	toggle.addEventListener("click", () => {
		const isOpen = toggle.getAttribute("aria-expanded") === "true";
		toggle.setAttribute("aria-expanded", String(!isOpen));
		menu.classList.toggle("is-open", !isOpen);
	});

	menu.querySelectorAll("a").forEach((link) => {
		link.addEventListener("click", close);
	});

	window.addEventListener("resize", () => {
		if (window.innerWidth > 840) close();
	});

	document.addEventListener("keydown", (event) => {
		if (event.key === "Escape") close();
	});
}

function setupRevealAnimations() {
	const elements = document.querySelectorAll(".reveal");

	if (
		!("IntersectionObserver" in window) ||
		window.matchMedia("(prefers-reduced-motion: reduce)").matches
	) {
		elements.forEach((element) => {
			element.classList.add("is-visible");
		});
		return;
	}

	const observer = new IntersectionObserver(
		(entries) => {
			entries.forEach((entry) => {
				if (!entry.isIntersecting) return;
				entry.target.classList.add("is-visible");
				observer.unobserve(entry.target);
			});
		},
		{ rootMargin: "0px 0px -8% 0px", threshold: 0.08 },
	);

	elements.forEach((element) => {
		observer.observe(element);
	});
}

function setupCommandCopy() {
	const button = document.querySelector("[data-copy-command]");
	const command =
		"tar -xzf FiveCut-linux-x64.tar.gz && cd FiveCut && ./fivecut";
	const toast = document.querySelector("[data-toast]");
	let toastTimer;

	if (!button) return;

	button.addEventListener("click", async () => {
		try {
			await navigator.clipboard.writeText(command);
		} catch {
			const input = document.createElement("textarea");
			input.value = command;
			input.setAttribute("readonly", "");
			input.style.position = "fixed";
			input.style.opacity = "0";
			document.body.append(input);
			input.select();
			document.execCommand("copy");
			input.remove();
		}

		button.classList.add("is-copied");
		button.setAttribute("aria-label", "Launch command copied");
		toast?.classList.add("is-visible");
		window.clearTimeout(toastTimer);
		toastTimer = window.setTimeout(() => {
			button.classList.remove("is-copied");
			button.setAttribute("aria-label", "Copy launch command");
			toast?.classList.remove("is-visible");
		}, 2200);
	});
}

function setupProductDepth() {
	const stage = document.querySelector("[data-product-stage]");
	const windowElement = stage?.querySelector(".editor-window");

	if (
		!stage ||
		!windowElement ||
		!window.matchMedia("(pointer: fine)").matches ||
		window.matchMedia("(prefers-reduced-motion: reduce)").matches
	) {
		return;
	}

	stage.addEventListener("pointermove", (event) => {
		const bounds = stage.getBoundingClientRect();
		const x = (event.clientX - bounds.left) / bounds.width - 0.5;
		const y = (event.clientY - bounds.top) / bounds.height - 0.5;
		windowElement.style.transform = `rotateX(${1.2 - y * 1.2}deg) rotateY(${x * 1.1}deg)`;
	});

	stage.addEventListener("pointerleave", () => {
		windowElement.style.transform = "rotateX(1.2deg) rotateY(0deg)";
	});
}

document.querySelector("[data-year]").textContent = String(
	new Date().getFullYear(),
);

hydrateLatestRelease();
describePlatform();
setupNavigation();
setupRevealAnimations();
setupCommandCopy();
setupProductDepth();
