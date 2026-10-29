// Injected (inline) at the very top of every game HTML page served by the self-host server.
// The game talks to the NW.js desktop shell through `parent.greenworks`, `parent.nw`, `parent.rpc`
// and `parent.setActivityDetails`. Served top-level, `parent === window`, so defining them here
// makes the game behave as the Steam client while the real Steam calls run on the server.
// `__SELFHOST_STATE__` is replaced server-side with a fresh Steam snapshot on every page load.
(function () {
	'use strict';
	var S = __SELFHOST_STATE__;
	window.__SELFHOST__ = true;

	function call(path, body) {
		return fetch('/__selfhost/api/' + path, {
			method: 'POST',
			credentials: 'same-origin',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body || {}),
		}).then(function (r) {
			return r.json();
		});
	}
	function cb(fn, arg) {
		if (typeof fn === 'function') fn(arg);
	}
	function forward(path, body, onOk, onErr, map) {
		call(path, body)
			.then(function (r) {
				if (r.ok) cb(onOk, map ? map(r) : undefined);
				else cb(onErr, r.error);
			})
			.catch(function (e) {
				cb(onErr, String(e));
			});
	}

	// The game prefers `parent.greenworks` when present, so the browser sees a greenworks-shaped API even though the
	// server talks to Steam through steamworks.js. The page is only served once Steam is up, hence init() is true.
	window.greenworks = {
		init: function () { return true; },
		initAPI: function () { return true; },
		isSteamRunning: function () { return true; },
		getAppId: function () { return S.appId; },
		getSteamId: function () { return S.steamId; },
		isSubscribedApp: function (appId) { return S.owned[String(appId)] === true; },
		// steamworks.js can't enumerate achievements; the game ships the same list for its own steamworks path.
		getAchievementNames: function () {
			return typeof game !== 'undefined' && Array.isArray(game.steamAchievementNames) ? game.steamAchievementNames.slice() : [];
		},
		activateAchievement: function (name, onOk, onErr) {
			forward('achievement', { name: name }, onOk, onErr);
		},
		setRichPresence: function (key, value) {
			call('richpresence', { key: key, value: value }).catch(function () {});
			return true;
		},
		getAuthSessionTicket: function (onOk, onErr) {
			forward('ticket', null, onOk, onErr, function (r) {
				// The game calls ticket.ticket.toString('hex'), as on a Node Buffer.
				return { ticket: { toString: function () { return r.hex; } } };
			});
		},
		isCloudEnabled: function () { return S.cloudEnabled; },
		isCloudEnabledForUser: function () { return S.cloudEnabledForUser; },
		saveTextToFile: function (file, text, onOk, onErr) {
			forward('cloud/write', { file: file, text: text }, onOk, onErr);
		},
		readTextFromFile: function (file, onOk, onErr) {
			forward('cloud/read', { file: file }, onOk, onErr, function (r) { return r.text; });
		},
		deleteFile: function (file, onOk, onErr) {
			forward('cloud/delete', { file: file }, onOk, onErr);
		},
	};

	// Discord Rich Presence lived in the desktop shell; there is no Discord client in a remote browser.
	window.setActivityDetails = function () {};
	window.rpc = { clearActivity: function () {}, setActivity: function () {} };

	var zoom = 0;
	window.nw = {
		App: {
			argv: [],
			clearCache: function () {},
			closeAllWindows: function () { location.reload(); },
		},
		Shell: {
			openExternal: function (url) { window.open(url, '_blank', 'noopener'); },
		},
		Window: {
			get: function () {
				return {
					get zoomLevel() { return zoom; },
					set zoomLevel(z) {
						zoom = z;
						// NW.js zoom levels are steps of 20%.
						document.documentElement.style.zoom = String(Math.pow(1.2, z));
					},
				};
			},
		},
	};
})();
