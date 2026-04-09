// ==UserScript==
// @name         vCtrl Deephire v3.0
// @namespace    http://tampermonkey.net/
// @version      3.0
// @description  手动投递板块 + 爬取板块 + 设置持久化（数据库恢复）
// @author       vCtrl
// @match        *://www.deephire.cn/jobseeker/*
// @homepageURL  https://github.com/CodexNewty/deephire-userscript
// @supportURL   https://github.com/CodexNewty/deephire-userscript/issues
// @updateURL    https://raw.githubusercontent.com/CodexNewty/deephire-userscript/main/deephire-v22.user.js
// @downloadURL  https://raw.githubusercontent.com/CodexNewty/deephire-userscript/main/deephire-v22.user.js
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function() {
	'use strict';
	const APP_VERSION = '3.0';
	const GLOBAL_INIT_KEY = '__vctrl_deephire_singleton_initialized__';
	if (typeof window.vCtrl_Unload_v21 === 'function') {
		try { window.vCtrl_Unload_v21(); } catch (e) {}
	}

	const PANEL_ID = 'vctrl-v21-panel';
	const STYLE_ID = 'vctrl-v21-style';
	const FILTER_MODAL_ID = 'vctrl-v21-filter-modal';
	const DATA_MODAL_ID = 'vctrl-v21-data-modal';
	const AI_CFG_MODAL_ID = 'vctrl-v21-ai-modal';

	const V5_DB_NAME = 'vCtrl_Job_DB';
	const V5_DB_VERSION = 2;
	const V5_STORE_CONFIG = 'configStore';
	const V5_STORE_STATS = 'statsStore';

	const V19_DB_NAME = 'vCtrl_JD_Spider_DB';
	const V19_DB_VERSION = 2;
	const V19_STORE_CONFIG = 'spiderConfig';
	const V19_STORE_DATA = 'jdDataStore';
	const V19_STORE_HISTORY = 'jdHistoryStore';


	const FILTER_TEMPLATE = {
		'薪资待遇': ['不限', '3K以下', '3-5K', '5-10K', '10-20K', '20-50K', '50K以上', '面议'],
		'经验要求': ['不限', '应届/在校', '1年以内', '1-3年', '3-5年', '5-10年', '10年以上'],
		'公司规模': ['不限', '0-20人', '20-99人', '100-499人', '500-999人', '1000-9999人', '10000人以上'],
		'学历要求': ['不限', '初中以下', '高中', '中专', '大专', '本科', '硕士', '博士']
	};

	const state = {
		activeTab: 'manual',
		uiState: { x: '', y: '', w: '380px', h: '640px', collapsed: false },
		sharedLimits: { maxCount: 20, delayMs: 1200 },
		rules: {
			whitelist: [],
			blacklist: ['外包', '驻场', '兼职']
		},

		v5: {
			selectiveMode: true,
			maxBatchCount: 20,
			applyDelay: 1200,
			autoFilterEnabled: true,
			filterConfig: {
				'薪资待遇': ['5-10K', '10-20K'],
				'经验要求': ['应届/在校', '1年以内', '1-3年'],
				'公司规模': ['100-499人', '500-999人', '1000-9999人'],
				'学历要求': ['大专', '本科']
			}
		},

		v19: {
			fetchMode: 'all',
			deepBlacklist: ['两班倒', '倒班', '单休' ],
			fetchDelay: 1200,
			maxFetchCount: 20,
			dataSort: 'rule',
			dataView: 'active',
			n8nLoopEnabled: false,
			n8nLoopRounds: 1,
			forceSendMaxCount: 20,
			deliveryPolicy: 'keep-last',
			n8nUrl: '',
			aiProfiles: [
				{ id: 'default_1', name: 'Gemini (免费)', endpoint: 'https://openrouter.ai/api/v1/chat/completions', key: '', model: 'google/gemini-2.5-flash-free' }
			],
			currentProfileId: 'default_1'
		}
	};

	let v5DB = null;
	let v19DB = null;
	let cardObserver = null;
	let isRunningApply = false;
	let isFetching = false;
	let isPaused = false;
	let shouldStop = false;
	let isProcessingFilter = false;

	const eventRefs = {};
	const jdNetworkMap = new Map();
	const jdIdSet = new Set();
	const SPY_EVENT = 'VCTRL_SPY_DATA_V21';
	const CLOUD_STOPWORDS = ['五险一金', '带薪年假', '双休', '周末双休', '包吃住', '13薪', '十三薪', '年终奖', '定期体检', '节日福利', '下午茶', '不加班', '沟通能力', '吃苦耐劳', '责任心', '团队合作', '团队协作', '工作态度', '抗压能力', '执行力', '善于学习', '积极主动'];

	const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

	// ======================== 主世界穿透雷达（参考 1.js） ========================
	const mainWorldRadar = function(eventName) {
		const originalFetch = window.fetch;
		const originalXhrSend = XMLHttpRequest.prototype.send;

		function emit(data) {
			window.dispatchEvent(new CustomEvent(eventName, { detail: data }));
		}

		window.fetch = async function(...args) {
			const response = await originalFetch.apply(this, args);
			try { response.clone().json().then(emit).catch(() => {}); } catch (e) {}
			return response;
		};

		XMLHttpRequest.prototype.send = function(...args) {
			this.addEventListener('load', function() {
				if (this.responseType === '' || this.responseType === 'text' || this.responseType === 'json') {
					try { emit(typeof this.response === 'string' ? JSON.parse(this.response) : this.response); } catch (e) {}
				}
			});
			return originalXhrSend.apply(this, args);
		};
	};

	function injectMainWorldRadar() {
		const script = document.createElement('script');
		script.textContent = `(${mainWorldRadar.toString()})(${JSON.stringify(SPY_EVENT)});`;
		(document.head || document.documentElement).appendChild(script);
		script.remove();
	}

	// ======================== DB ========================
	const V5DB = {
		init: () => new Promise((resolve, reject) => {
			const req = indexedDB.open(V5_DB_NAME, V5_DB_VERSION);
			req.onerror = (e) => reject(e.target.errorCode);
			req.onsuccess = (e) => { v5DB = e.target.result; resolve(); };
			req.onupgradeneeded = (e) => {
				const db = e.target.result;
				if (!db.objectStoreNames.contains(V5_STORE_CONFIG)) db.createObjectStore(V5_STORE_CONFIG, { keyPath: 'key' });
				if (!db.objectStoreNames.contains(V5_STORE_STATS)) db.createObjectStore(V5_STORE_STATS, { keyPath: 'id', autoIncrement: true });
			};
		}),
		addStat: (data) => new Promise((resolve) => {
			if (!v5DB) return resolve(false);
			const req = v5DB.transaction(V5_STORE_STATS, 'readwrite').objectStore(V5_STORE_STATS).add(data);
			req.onsuccess = () => resolve(true);
			req.onerror = () => resolve(false);
		}),
		getAllStats: () => new Promise((resolve) => {
			if (!v5DB) return resolve([]);
			const req = v5DB.transaction(V5_STORE_STATS, 'readonly').objectStore(V5_STORE_STATS).getAll();
			req.onsuccess = () => resolve(req.result || []);
			req.onerror = () => resolve([]);
		})
	};

	const V19DB = {
		init: () => new Promise((resolve, reject) => {
			const req = indexedDB.open(V19_DB_NAME, V19_DB_VERSION);
			req.onerror = (e) => reject(e.target.errorCode);
			req.onsuccess = (e) => { v19DB = e.target.result; resolve(); };
			req.onupgradeneeded = (e) => {
				const db = e.target.result;
				if (!db.objectStoreNames.contains(V19_STORE_CONFIG)) db.createObjectStore(V19_STORE_CONFIG, { keyPath: 'key' });
				if (!db.objectStoreNames.contains(V19_STORE_DATA)) db.createObjectStore(V19_STORE_DATA, { keyPath: 'encryptId' });
				if (!db.objectStoreNames.contains(V19_STORE_HISTORY)) db.createObjectStore(V19_STORE_HISTORY, { keyPath: 'encryptId' });
			};
		}),
		getJD: (encryptId) => new Promise((resolve) => {
			if (!v19DB) return resolve(null);
			const req = v19DB.transaction(V19_STORE_DATA, 'readonly').objectStore(V19_STORE_DATA).get(encryptId);
			req.onsuccess = () => resolve(req.result || null);
			req.onerror = () => resolve(null);
		}),
		saveJD: (data) => new Promise((resolve) => {
			if (!v19DB) return resolve(false);
			const req = v19DB.transaction(V19_STORE_DATA, 'readwrite').objectStore(V19_STORE_DATA).put(data);
			req.onsuccess = () => resolve(true);
			req.onerror = () => resolve(false);
		}),
		getAllJDs: () => new Promise((resolve) => {
			if (!v19DB) return resolve([]);
			const req = v19DB.transaction(V19_STORE_DATA, 'readonly').objectStore(V19_STORE_DATA).getAll();
			req.onsuccess = () => resolve(req.result || []);
			req.onerror = () => resolve([]);
		}),
		clearAllJDs: () => new Promise((resolve) => {
			if (!v19DB) return resolve(false);
			const req = v19DB.transaction(V19_STORE_DATA, 'readwrite').objectStore(V19_STORE_DATA).clear();
			req.onsuccess = () => resolve(true);
			req.onerror = () => resolve(false);
		}),
		deleteJD: (encryptId) => new Promise((resolve) => {
			if (!v19DB) return resolve(false);
			const req = v19DB.transaction(V19_STORE_DATA, 'readwrite').objectStore(V19_STORE_DATA).delete(encryptId);
			req.onsuccess = () => resolve(true);
			req.onerror = () => resolve(false);
		}),
		getHistoryJD: (encryptId) => new Promise((resolve) => {
			if (!v19DB) return resolve(null);
			const req = v19DB.transaction(V19_STORE_HISTORY, 'readonly').objectStore(V19_STORE_HISTORY).get(encryptId);
			req.onsuccess = () => resolve(req.result || null);
			req.onerror = () => resolve(null);
		}),
		saveHistoryJD: (data) => new Promise((resolve) => {
			if (!v19DB) return resolve(false);
			const req = v19DB.transaction(V19_STORE_HISTORY, 'readwrite').objectStore(V19_STORE_HISTORY).put(data);
			req.onsuccess = () => resolve(true);
			req.onerror = () => resolve(false);
		}),
		getAllHistoryJDs: () => new Promise((resolve) => {
			if (!v19DB) return resolve([]);
			const req = v19DB.transaction(V19_STORE_HISTORY, 'readonly').objectStore(V19_STORE_HISTORY).getAll();
			req.onsuccess = () => resolve(req.result || []);
			req.onerror = () => resolve([]);
		}),
		clearHistoryJDs: () => new Promise((resolve) => {
			if (!v19DB) return resolve(false);
			const req = v19DB.transaction(V19_STORE_HISTORY, 'readwrite').objectStore(V19_STORE_HISTORY).clear();
			req.onsuccess = () => resolve(true);
			req.onerror = () => resolve(false);
		})
	};

	const SettingsDB = {
		get: (key) => new Promise((resolve) => {
			if (!v19DB) return resolve(null);
			const req = v19DB.transaction(V19_STORE_CONFIG, 'readonly').objectStore(V19_STORE_CONFIG).get(key);
			req.onsuccess = () => resolve(req.result ? req.result.value : null);
			req.onerror = () => resolve(null);
		}),
		set: (key, value) => new Promise((resolve) => {
			if (!v19DB) return resolve(false);
			const req = v19DB.transaction(V19_STORE_CONFIG, 'readwrite').objectStore(V19_STORE_CONFIG).put({ key, value });
			req.onsuccess = () => resolve(true);
			req.onerror = () => resolve(false);
		})
	};

	async function loadSettings() {
		const saved = await SettingsDB.get('v21_state');
		if (!saved || typeof saved !== 'object') return;
		if (saved.activeTab) state.activeTab = saved.activeTab;
		if (saved.uiState) state.uiState = Object.assign(state.uiState, saved.uiState);
		if (saved.sharedLimits) state.sharedLimits = Object.assign(state.sharedLimits, saved.sharedLimits);
		if (saved.rules) state.rules = Object.assign(state.rules, saved.rules);
		if (saved.v5) state.v5 = Object.assign(state.v5, saved.v5);
		if (saved.v19) state.v19 = Object.assign(state.v19, saved.v19);

		// 兼容旧版本：共享参数未配置时，优先沿用旧的手动参数
		if (!saved.sharedLimits) {
			state.sharedLimits.maxCount = state.v5.maxBatchCount || state.v19.maxFetchCount || 20;
			state.sharedLimits.delayMs = state.v5.applyDelay || state.v19.fetchDelay || 1200;
		}
		state.v5.maxBatchCount = state.sharedLimits.maxCount;
		state.v19.maxFetchCount = state.sharedLimits.maxCount;
		state.v5.applyDelay = state.sharedLimits.delayMs;
		state.v19.fetchDelay = state.sharedLimits.delayMs;

		// 兼容旧版本：若还没有全局规则，则从旧字段迁移
		if ((!state.rules.whitelist || state.rules.whitelist.length === 0) && Array.isArray(state.v19.keywords)) {
			state.rules.whitelist = state.v19.keywords.slice();
		}
		if ((!state.rules.blacklist || state.rules.blacklist.length === 0) && Array.isArray(state.v19.blacklist)) {
			state.rules.blacklist = state.v19.blacklist.slice();
		}
	}

	async function saveSettings() {
		await SettingsDB.set('v21_state', {
			activeTab: state.activeTab,
			uiState: state.uiState,
			sharedLimits: state.sharedLimits,
			rules: state.rules,
			v5: state.v5,
			v19: state.v19
		});
	}

	function sortJDsByMode(items, mode = 'rule') {
		const data = Array.isArray(items) ? items.slice() : [];
		if (mode === 'name') {
			data.sort((a, b) => String(a.title || '').localeCompare(String(b.title || ''), 'zh-CN'));
			return data;
		}
		if (mode === 'time') {
			data.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
			return data;
		}
		data.sort((a, b) => {
			const aDelivered = a.deliveryStatus === 'delivered' ? 1 : 0;
			const bDelivered = b.deliveryStatus === 'delivered' ? 1 : 0;
			if (aDelivered !== bDelivered) return aDelivered - bDelivered;
			return (b.timestamp || 0) - (a.timestamp || 0);
		});
		return data;
	}

	async function migrateDeliveredMainToHistory() {
		const all = await V19DB.getAllJDs();
		const delivered = all.filter(item => item && item.deliveryStatus === 'delivered');
		if (!delivered.length) return 0;
		let moved = 0;
		for (const item of delivered) {
			item.archivedAt = item.archivedAt || Date.now();
			item.archivedBy = item.archivedBy || 'legacy-migrate';
			const ok = await V19DB.saveHistoryJD(item);
			if (!ok) continue;
			await V19DB.deleteJD(item.encryptId);
			moved++;
		}
		return moved;
	}

	function tryParseJsonText(text) {
		if (!text || typeof text !== 'string') return null;
		const t = text.trim();
		if (!t) return null;
		try { return JSON.parse(t); } catch (e) {}
		const fenced = t.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
		if (fenced && fenced[1]) {
			try { return JSON.parse(fenced[1].trim()); } catch (e) {}
		}
		const arrStart = t.indexOf('[');
		const arrEnd = t.lastIndexOf(']');
		if (arrStart >= 0 && arrEnd > arrStart) {
			try { return JSON.parse(t.slice(arrStart, arrEnd + 1)); } catch (e) {}
		}
		return null;
	}

	function extractDecisionArray(raw) {
		if (Array.isArray(raw)) {
			if (raw.length && raw.every(item => item && typeof item === 'object' && item.json && typeof item.json === 'object')) {
				return raw.map(item => item.json);
			}
			return raw;
		}
		if (!raw) return [];
		if (typeof raw === 'string') {
			const parsed = tryParseJsonText(raw);
			return extractDecisionArray(parsed);
		}
		if (typeof raw === 'object') {
			if (Array.isArray(raw.results)) return raw.results;
			if (Array.isArray(raw.data)) return raw.data;
			if (Array.isArray(raw.items)) return raw.items;
			if (Array.isArray(raw.output)) return raw.output;
			if (Array.isArray(raw.body)) return raw.body;
			if (Array.isArray(raw.response)) return raw.response;
			if (raw.choices && raw.choices[0]?.message?.content) {
				const parsed = tryParseJsonText(raw.choices[0].message.content);
				return extractDecisionArray(parsed);
			}
			if (raw.output && typeof raw.output === 'string') {
				const parsed = tryParseJsonText(raw.output);
				return extractDecisionArray(parsed);
			}
			if (raw.result && typeof raw.result === 'string') {
				const parsed = tryParseJsonText(raw.result);
				return extractDecisionArray(parsed);
			}
			if (raw.content && typeof raw.content === 'string') {
				const parsed = tryParseJsonText(raw.content);
				return extractDecisionArray(parsed);
			}
			if (raw.id || raw.encryptId) return [raw];
		}
		return [];
	}

	// ======================== UI ========================
	function logMsg(msg, type = 'info') {
		const box = document.getElementById('vctrl-log');
		if (!box) return;
		const colors = { info: '#aaa', success: '#4caf50', warning: '#ff9800', error: '#f44336' };
		const line = document.createElement('div');
		line.style.color = colors[type] || '#aaa';
		line.style.marginBottom = '4px';
		line.innerText = `[${new Date().toLocaleTimeString('en-US', { hour12: false })}] ${msg}`;
		box.appendChild(line);
		while (box.children.length > 120) box.removeChild(box.firstChild);
		box.scrollTop = box.scrollHeight;
	}

	async function refreshCounters() {
		const allStats = await V5DB.getAllStats();
		const start = new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate()).getTime();
		const end = start + 24 * 60 * 60 * 1000;
		const today = allStats.filter(s => s.timestamp >= start && s.timestamp < end).length;
		const setText = (ids, text) => ids.forEach(id => { const el = document.getElementById(id); if (el) el.innerText = text; });
		const applyEl = document.getElementById('vctrl-apply-counter');
		if (applyEl) applyEl.innerText = `已投 ${allStats.length}（今 ${today}）`;

		const jdTotal = (await V19DB.getAllJDs()).length;
		setText(['vctrl-jd-total', 'vctrl-jd-total-spider'], String(jdTotal));

		setText(['vctrl-radar-count', 'vctrl-radar-count-spider'], String(jdIdSet.size));
	}

	function applyPanelState() {
		const panel = document.getElementById(PANEL_ID);
		if (!panel) return;
		if (state.uiState.x) {
			panel.style.left = state.uiState.x;
			panel.style.top = state.uiState.y;
			panel.style.right = 'auto';
			panel.style.bottom = 'auto';
		}
		panel.style.width = state.uiState.w;
		panel.style.height = state.uiState.h;
		panel.classList.toggle('collapsed', !!state.uiState.collapsed);
	}

	function switchTab(tab) {
		state.activeTab = tab;
		document.querySelectorAll(`#${PANEL_ID} .vctrl-tab`).forEach(t => t.classList.remove('active'));
		document.querySelectorAll(`#${PANEL_ID} .vctrl-section`).forEach(s => s.classList.remove('active'));
		const tabEl = document.querySelector(`#${PANEL_ID} .vctrl-tab[data-tab="${tab}"]`);
		const secEl = document.querySelector(`#${PANEL_ID} #vctrl-section-${tab}`);
		if (tabEl) tabEl.classList.add('active');
		if (secEl) secEl.classList.add('active');
		saveSettings();
	}

	function syncFormFromState() {
		const setVal = (id, val) => { const el = document.getElementById(id); if (el) el.value = val; };
		const setChecked = (id, val) => { const el = document.getElementById(id); if (el) el.checked = !!val; };

		setChecked('vctrl-selective-mode', state.v5.selectiveMode);
		setChecked('vctrl-auto-filter-toggle', state.v5.autoFilterEnabled);

		setVal('vctrl-fetch-mode', state.v19.fetchMode);
		setVal('vctrl-fetch-deep-blacklist', state.v19.deepBlacklist.join(', '));
		setVal('vctrl-delivery-policy', state.v19.deliveryPolicy || 'keep-last');
		setVal('vctrl-n8n-url', state.v19.n8nUrl || '');
		setChecked('vctrl-n8n-loop-enabled', !!state.v19.n8nLoopEnabled);
		setVal('vctrl-n8n-loop-rounds', state.v19.n8nLoopRounds || 1);
		setVal('vctrl-force-send-max', state.v19.forceSendMaxCount || 20);

		setVal('vctrl-global-whitelist', state.rules.whitelist.join(', '));
		setVal('vctrl-global-blacklist', state.rules.blacklist.join(', '));
		setVal('vctrl-setting-shared-max', state.sharedLimits.maxCount);
		setVal('vctrl-setting-shared-delay', state.sharedLimits.delayMs);
		renderAIProfileSelect();
	}

	function syncStateFromForm() {
		state.v5.selectiveMode = !!document.getElementById('vctrl-selective-mode')?.checked;
		state.v5.autoFilterEnabled = !!document.getElementById('vctrl-auto-filter-toggle')?.checked;

		state.v19.fetchMode = document.getElementById('vctrl-fetch-mode')?.value || 'all';
		state.v19.deepBlacklist = (document.getElementById('vctrl-fetch-deep-blacklist')?.value || '').split(/[,，]/).map(s => s.trim()).filter(Boolean);
		state.v19.deliveryPolicy = document.getElementById('vctrl-delivery-policy')?.value || 'keep-last';
		state.v19.n8nUrl = (document.getElementById('vctrl-n8n-url')?.value || '').trim();
		state.v19.n8nLoopEnabled = !!document.getElementById('vctrl-n8n-loop-enabled')?.checked;
		state.v19.n8nLoopRounds = Math.max(1, parseInt(document.getElementById('vctrl-n8n-loop-rounds')?.value, 10) || 1);
		state.v19.forceSendMaxCount = Math.max(1, parseInt(document.getElementById('vctrl-force-send-max')?.value, 10) || 20);

		state.rules.whitelist = (document.getElementById('vctrl-global-whitelist')?.value || '').split(/[,，]/).map(s => s.trim()).filter(Boolean);
		state.rules.blacklist = (document.getElementById('vctrl-global-blacklist')?.value || '').split(/[,，]/).map(s => s.trim()).filter(Boolean);
		state.sharedLimits.maxCount = parseInt(document.getElementById('vctrl-setting-shared-max')?.value, 10) || 20;
		state.sharedLimits.delayMs = parseInt(document.getElementById('vctrl-setting-shared-delay')?.value, 10) || 1200;
		state.v5.maxBatchCount = state.sharedLimits.maxCount;
		state.v19.maxFetchCount = state.sharedLimits.maxCount;
		state.v5.applyDelay = state.sharedLimits.delayMs;
		state.v19.fetchDelay = state.sharedLimits.delayMs;
	}

	function renderAIProfileSelect() {
		const select = document.getElementById('vctrl-ai-profile-select');
		if (!select) return;
		const profiles = Array.isArray(state.v19.aiProfiles) ? state.v19.aiProfiles : [];
		const validProfiles = profiles.filter(p => p && p.id && p.name && p.endpoint && p.model);
		if (validProfiles.length !== profiles.length) {
			state.v19.aiProfiles = validProfiles;
		}
		if (!state.v19.aiProfiles.length) {
			state.v19.aiProfiles = [{ id: 'default_1', name: '默认模型', endpoint: 'https://openrouter.ai/api/v1/chat/completions', key: '', model: 'google/gemini-2.5-flash-free' }];
			state.v19.currentProfileId = 'default_1';
		}
		if (!state.v19.aiProfiles.some(p => p.id === state.v19.currentProfileId)) {
			state.v19.currentProfileId = state.v19.aiProfiles[0].id;
		}
		select.innerHTML = '';
		state.v19.aiProfiles.forEach(p => {
			const option = document.createElement('option');
			option.value = p.id;
			option.innerText = p.name;
			if (p.id === state.v19.currentProfileId) option.selected = true;
			select.appendChild(option);
		});
		const addOpt = document.createElement('option');
		addOpt.value = 'ADD_NEW';
		addOpt.innerText = '➕ 新增AI模型节点...';
		select.appendChild(addOpt);
	}

	function getActiveAIConfig() {
		const profiles = Array.isArray(state.v19.aiProfiles) ? state.v19.aiProfiles : [];
		return profiles.find(p => p.id === state.v19.currentProfileId) || profiles[0] || null;
	}

	function renderFilterConfigModal() {
		const body = document.getElementById('vctrl-filter-modal-body');
		if (!body) return;
		let html = '';
		for (const [category, options] of Object.entries(FILTER_TEMPLATE)) {
			const selected = state.v5.filterConfig[category] || [];
			html += `<div class="fg" data-category="${category}"><div class="tt">${category}</div><div class="tags">`;
			options.forEach(opt => {
				const active = selected.includes(opt) || (selected.length === 0 && opt === '不限');
				html += `<span class="tag ${active ? 'active' : ''}" data-val="${opt}">${opt}</span>`;
			});
			html += '</div></div>';
		}
		body.innerHTML = html;

		body.querySelectorAll('.tag').forEach(tag => {
			tag.addEventListener('click', function() {
				const siblings = this.parentElement.querySelectorAll('.tag');
				const isUnlimited = this.getAttribute('data-val') === '不限';
				if (isUnlimited) {
					siblings.forEach(s => s.classList.remove('active'));
					this.classList.add('active');
				} else {
					this.classList.toggle('active');
					this.parentElement.querySelector('[data-val="不限"]')?.classList.remove('active');
					const has = Array.from(siblings).some(s => s.classList.contains('active'));
					if (!has) this.parentElement.querySelector('[data-val="不限"]')?.classList.add('active');
				}
			});
		});
	}

	function saveFilterConfigModal() {
		const groups = document.querySelectorAll('#vctrl-filter-modal-body .fg');
		const config = {};
		groups.forEach(g => {
			const category = g.getAttribute('data-category');
			const vals = Array.from(g.querySelectorAll('.tag.active')).map(el => el.getAttribute('data-val')).filter(v => v !== '不限');
			if (vals.length > 0) config[category] = vals;
		});
		state.v5.filterConfig = config;
		saveSettings();
		document.getElementById(FILTER_MODAL_ID).style.display = 'none';
		logMsg('筛选配置已保存到数据库。', 'success');
	}

	// ======================== V5 手动投递 ========================
	function normalizeTitle(card) {
		return (card.querySelector('.job-title')?.innerText || card.querySelector('.job-card-title-wrap .job-title')?.innerText || '').replace('职位名称：', '').trim();
	}
	function normalizeCompany(card) {
		return (card.querySelector('.company-info-item.strong')?.innerText || '').replace('公司名称：', '').trim();
	}

	function processJobCardsForManual() {
		const cards = document.querySelectorAll('.job-card-new:not(.vctrl-v21-processed)');
		cards.forEach(card => {
			card.classList.add('vctrl-v21-processed');
			const title = normalizeTitle(card);
			if ((state.rules.blacklist || []).some(kw => kw.trim() && title.includes(kw.trim()))) {
				card.classList.add('vctrl-v21-blocked');
			}

			const wrap = card.querySelector('.job-card-footer .job-action-wrap');
			if (!wrap || wrap.querySelector('.vctrl-checkbox')) return;
			const cb = document.createElement('input');
			cb.type = 'checkbox';
			cb.className = 'vctrl-checkbox';
			cb.style.cssText = 'width:16px;height:16px;margin-right:8px;cursor:pointer;';
			const stop = (e) => e.stopPropagation();
			cb.addEventListener('click', stop);
			cb.addEventListener('mousedown', stop);
			cb.addEventListener('mouseup', stop);
			wrap.insertBefore(cb, wrap.firstChild);
		});
	}

	function initCardObserver() {
		if (cardObserver) return;
		cardObserver = new MutationObserver((ms) => {
			if (ms.some(m => m.addedNodes.length > 0)) processJobCardsForManual();
		});
		cardObserver.observe(document.body, { childList: true, subtree: true });
		processJobCardsForManual();
	}

	async function executeManualApply() {
		if (isRunningApply) return;
		isRunningApply = true;

		const targets = [];
		document.querySelectorAll('.job-card-new:not(.vctrl-v21-blocked)').forEach(card => {
			const btn = card.querySelector('.btn-submit:not(.disabled)');
			const cb = card.querySelector('.vctrl-checkbox');
			if (!btn) return;
			if (!state.v5.selectiveMode || (cb && cb.checked)) targets.push(card);
		});

		if (targets.length === 0) {
			logMsg('无可投递岗位（未勾选或无可投按钮）', 'warning');
			isRunningApply = false;
			return;
		}

		const limit = Math.min(targets.length, state.sharedLimits.maxCount);
		let success = 0;
		for (let i = 0; i < limit; i++) {
			const card = targets[i];
			const btn = card.querySelector('.btn-submit:not(.disabled)');
			if (!btn) continue;
			btn.click();
			await V5DB.addStat({
				title: normalizeTitle(card) || '未知',
				salary: card.querySelector('.job-salary')?.innerText?.trim() || '未知',
				company: normalizeCompany(card) || '未知',
				timestamp: Date.now(),
				source: 'vCtrl_V21'
			});
			success++;
			logMsg(`投递中 ${i + 1}/${limit}`, 'info');
			await sleep(state.sharedLimits.delayMs + Math.random() * 300);
		}
		await refreshCounters();
		logMsg(`投递完成：${success} 份`, 'success');
		isRunningApply = false;
	}

	function executeFilterAction(isClear = false) {
		if (isProcessingFilter) return;
		const filterBtn = document.querySelector('.filter-btn');
		if (!filterBtn) {
			logMsg('未找到筛选按钮', 'error');
			return;
		}
		isProcessingFilter = true;

		if (!document.getElementById('vctrl-v21-silent-style')) {
			const s = document.createElement('style');
			s.id = 'vctrl-v21-silent-style';
			s.innerHTML = '.b-trigger-popup { opacity:0 !important; pointer-events:none !important; transition:none !important; animation:none !important; }';
			document.head.appendChild(s);
		}

		const mo = new MutationObserver((_, obs) => {
			const panel = document.querySelector('.popover-workspace-filter');
			if (!panel) return;
			obs.disconnect();

			panel.querySelectorAll('.filter-row').forEach(row => {
				const label = row.querySelector('.filter-label')?.innerText?.trim();
				const targetValues = isClear ? [] : (state.v5.filterConfig[label] || []);
				const options = row.querySelectorAll('.filter-option');
				if (isClear) {
					if (options.length > 0 && !options[0].classList.contains('selected')) options[0].click();
				} else if (state.v5.filterConfig[label]) {
					options.forEach(opt => {
						const shouldBe = targetValues.includes(opt.innerText.trim());
						const selected = opt.classList.contains('selected');
						if (shouldBe !== selected) opt.click();
					});
				}
			});

			requestAnimationFrame(() => {
				panel.querySelector('.b-button-primary')?.click();
				setTimeout(() => {
					document.getElementById('vctrl-v21-silent-style')?.remove();
					isProcessingFilter = false;
					logMsg(isClear ? '筛选已清空' : '筛选已应用', 'success');
					processJobCardsForManual();
				}, 220);
			});
		});

		mo.observe(document.body, { childList: true, subtree: true });
		filterBtn.click();
	}

	function startAutoFilter() {
		if (!state.v5.autoFilterEnabled) return;
		const probe = setInterval(() => {
			if (document.querySelector('.filter-btn')) {
				clearInterval(probe);
				executeFilterAction(false);
			}
		}, 300);
		setTimeout(() => clearInterval(probe), 10000);
	}

	// ======================== V19 爬取 ========================
	function parseNetworkData(data) {
		const walk = (obj) => {
			if (!obj || typeof obj !== 'object') return;
			if (Array.isArray(obj)) { obj.forEach(walk); return; }
			const id = obj.encryptId || obj.encryptJobId;
			const title = obj.title || obj.positionName || obj.jobName;
			const company = obj.brand || obj.brandName || obj.companyName;
			if (id) jdIdSet.add(String(id));
			if (id && title && company) {
				const key = `${title.trim()}|${company.trim()}`;
				if (!jdNetworkMap.has(key)) jdNetworkMap.set(key, id);
			}
			Object.values(obj).forEach(walk);
		};
		try { walk(data); } catch (e) {}
		['vctrl-radar-count', 'vctrl-radar-count-spider'].forEach(id => {
			const el = document.getElementById(id);
			if (el) el.innerText = jdIdSet.size;
		});
	}

	const nativeFetch = window.fetch;
	const nativeXhrSend = XMLHttpRequest.prototype.send;

	window.addEventListener(SPY_EVENT, function(event) {
		if (!event || !event.detail) return;
		parseNetworkData(event.detail);
	});

	async function autoScrollCollectRadar(rounds = 10) {
		let last = jdIdSet.size;
		let stable = 0;
		for (let i = 0; i < rounds && stable < 3; i++) {
			window.scrollBy(0, Math.max(400, Math.floor(window.innerHeight * 0.75)));
			await sleep(420);
			if (jdIdSet.size === last) stable++;
			else { stable = 0; last = jdIdSet.size; }
		}
	}

	async function executeSpider() {
		if (isFetching) return;
		if (jdIdSet.size === 0) {
			logMsg('雷达为空，正在自动滚动采集...', 'warning');
			await autoScrollCollectRadar(12);
			if (jdIdSet.size === 0) {
				logMsg('滚动后仍无雷达数据，请手动翻页或切换列表触发岗位请求。', 'error');
			}
		}

		isFetching = true;
		isPaused = false;
		shouldStop = false;
		toggleSpiderUI('running');
		logMsg('--- 启动汲取流水线 ---', 'info');

		const targets = [];
		const seen = new Set();
		document.querySelectorAll('.job-card-new').forEach(card => {
			const title = normalizeTitle(card);
			if ((state.rules.blacklist || []).some(kw => kw.trim() && title.includes(kw.trim()))) return;
			if (state.v19.fetchMode === 'rule' && !(state.rules.whitelist || []).some(kw => kw.trim() && title.includes(kw.trim()))) return;
			const company = normalizeCompany(card);
			const id = jdNetworkMap.get(`${title}|${company}`);
			if (id && !seen.has(id)) {
				seen.add(id);
				targets.push({ title, encryptId: id });
			}
		});

		for (const id of jdIdSet) {
			if (seen.has(id)) continue;
			seen.add(id);
			targets.push({ title: '雷达岗位', encryptId: id });
		}

		if (targets.length === 0) {
			logMsg('未锁定可抓取岗位。', 'warning');
			isFetching = false;
			toggleSpiderUI('idle');
			return;
		}

		let success = 0, skip = 0, dump = 0;
		for (let i = 0; i < targets.length; i++) {
			if (shouldStop) break;
			while (isPaused && !shouldStop) await sleep(300);
			if (shouldStop) break;
			if (success >= state.sharedLimits.maxCount) {
				logMsg(`达到上限 ${state.sharedLimits.maxCount}，提前停止。`, 'warning');
				break;
			}

			const t = targets[i];
			const existed = await V19DB.getJD(t.encryptId);
			const existedHistory = await V19DB.getHistoryJD(t.encryptId);
			if (existed || existedHistory) {
				skip++;
				continue;
			}

			logMsg(`[抓取] ${t.title}`, 'info');
			try {
				const res = await nativeFetch(`https://www.deephire.cn/wapi/partners/job/detail?encryptId=${t.encryptId}&source=0`, {
					credentials: 'include',
					headers: { 'X-Requested-With': 'XMLHttpRequest' }
				});
				const json = await res.json();
				if (json.code === 0 && json.result) {
					const detail = json.result;
					const desc = detail.description || '';
					const hit = state.v19.deepBlacklist.find(kw => kw.trim() && desc.includes(kw.trim()));
					if (hit) { dump++; continue; }
					const data = {
						encryptId: t.encryptId,
						title: detail.title,
						company: detail.brand,
						salary: detail.salary,
						description: desc,
						skills: detail.skills?.join(', ') || '',
						timestamp: Date.now(),
						rawJobDetail: detail
					};
					if (await V19DB.saveJD(data)) {
						success++;
						await refreshCounters();
					}
				}
			} catch (e) {
				logMsg(`请求失败: ${e.message}`, 'error');
			}

			await sleep(state.sharedLimits.delayMs + Math.random() * 250);
		}

		logMsg(`--- 结束：新增 ${success}，跳过 ${skip}，排雷 ${dump} ---`, 'success');
		isFetching = false;
		toggleSpiderUI('idle');
	}

	window.vCtrl_SendResumeGodMode = async function(encryptId, options = {}) {
		const jd = await V19DB.getJD(encryptId);
		const btn = document.getElementById(`vctrl-send-btn-${encryptId}`);
		if (!jd || !jd.rawJobDetail) {
			logMsg(`[错误] ${encryptId} 缺失底层原始载荷，不可投递。`, 'error');
			if (btn) {
				btn.innerText = '❌ 数据缺失';
				btn.style.background = '#f44336';
				btn.disabled = true;
			}
			return false;
		}

		if (btn) {
			btn.innerText = '投递中...';
			btn.disabled = true;
			btn.style.background = '#666';
		}

		try {
			const res = await nativeFetch('https://www.deephire.cn/wapi/partners/zp/geek/sendResume', {
				method: 'POST',
				credentials: 'include',
				headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
				body: JSON.stringify({ jobDetail: jd.rawJobDetail })
			});
			const json = await res.json();
			if (json.code === 0) {
				await handlePostDelivery(encryptId, options);
				if (btn) {
					btn.innerText = '✅ 已投递';
					btn.style.background = '#4caf50';
				}
				logMsg(`[投递成功] ${jd.company} - ${jd.title}`, 'success');
				return true;
			}

			const err = json.message || '未知限制';
			if (btn) {
				btn.innerText = '❌ 失败';
				btn.style.background = '#f44336';
				btn.disabled = false;
			}
			logMsg(`[投递失败] ${jd.company} - ${err}`, 'error');
			return false;
		} catch (e) {
			if (btn) {
				btn.innerText = '❌ 网络异常';
				btn.style.background = '#f44336';
				btn.disabled = false;
			}
			logMsg(`[投递异常] 网络断开: ${e.message}`, 'error');
			return false;
		}
	};

	async function handlePostDelivery(encryptId, options = {}) {
		const jdForStat = await V19DB.getJD(encryptId);
		if (jdForStat) {
			await V5DB.addStat({
				title: jdForStat.title || '未知',
				salary: jdForStat.salary || '未知',
				company: jdForStat.company || '未知',
				timestamp: Date.now(),
				source: 'vCtrl_V21_SendResume'
			});
		}
		const jd = await V19DB.getJD(encryptId);
		if (!jd) {
			await refreshCounters();
			return;
		}
		jd.deliveryStatus = 'delivered';
		jd.deliveredAt = Date.now();
		jd.archivedAt = Date.now();
		jd.archivedBy = options.archivedBy || 'manual';
		await V19DB.saveHistoryJD(jd);
		await V19DB.deleteJD(encryptId);
		await refreshCounters();
	}

	window.vCtrl_N8nAutoDelivery = async function() {
		const url = (document.getElementById('vctrl-n8n-url')?.value || '').trim();
		if (!url) return alert('请先在主面板配置 n8n Webhook 链接！');

		const keyword = prompt('【🧠 n8n 智能托管】\n输入过滤关键词（留空则全量推给 n8n 进行 AI 审核）：', '');
		if (keyword === null) return;

		const initialData = await V19DB.getAllJDs();
		if (!initialData.length) return alert('数据库为空！请先去汲取数据。');

		const runToEnd = !!state.v19.n8nLoopEnabled;
		const loopRounds = runToEnd ? Math.max(1, state.v19.n8nLoopRounds || 1) : 1;
		const previewSorted = sortJDsByMode(initialData, state.v19.dataSort || 'rule');
		const previewTargets = keyword.trim() ? previewSorted.filter(jd => (jd.title || '').includes(keyword.trim())) : previewSorted;
		if (!previewTargets.length) return alert('没有找到符合规则的岗位！');

		const MAX_BATCH_SIZE = 10;
		const previewBatchSize = Math.min(MAX_BATCH_SIZE, previewTargets.length);
		const previewBatches = Math.ceil(previewTargets.length / previewBatchSize);
		const execModeText = runToEnd ? `循环到结束（每轮 ${previewBatches} 批）` : '仅首批试跑（只发 1 批）';
		if (!confirm(`⚠️ 警告：即将启动 n8n 智能托管流水线！\n首轮岗位 ${previewTargets.length} 个，将按每批 ${previewBatchSize} 个切片。\n执行模式：${execModeText}\n连续投递轮次：${loopRounds}。\n请确保 n8n 处于 Listen 状态！`)) return;

		const btn = document.getElementById('vctrl-btn-n8n-send');
		if (btn) btn.disabled = true;

		let success = 0, rejected = 0, skipped = 0, fail = 0;
		for (let round = 1; round <= loopRounds; round++) {
			const current = await V19DB.getAllJDs();
			const sortedCurrent = sortJDsByMode(current, state.v19.dataSort || 'rule');
			const targets = keyword.trim() ? sortedCurrent.filter(jd => (jd.title || '').includes(keyword.trim())) : sortedCurrent;
			if (!targets.length) {
				logMsg(`[n8n] 第 ${round}/${loopRounds} 轮：无可处理岗位，提前结束。`, 'warning');
				break;
			}
			const batchSize = Math.min(MAX_BATCH_SIZE, targets.length);
			const totalBatches = Math.ceil(targets.length / batchSize);
			const effectiveBatches = runToEnd ? totalBatches : Math.min(totalBatches, 1);
			logMsg(`[n8n] 第 ${round}/${loopRounds} 轮总计 ${targets.length} 条，按每批 ${batchSize} 条；本轮执行 ${effectiveBatches}/${totalBatches} 批。`, 'info');
			for (let b = 0; b < effectiveBatches; b++) {
				const start = b * batchSize;
				const end = Math.min(start + batchSize, targets.length);
				const batch = targets.slice(start, end);
				if (btn) btn.innerText = `第${round}/${loopRounds}轮 批审中 (${b + 1}/${effectiveBatches})...`;
				logMsg(`[n8n] 第 ${round}/${loopRounds} 轮，发送批次 ${b + 1}/${effectiveBatches}，共 ${batch.length} 条岗位`, 'info');
				try {
					const payloadJobs = batch.map(jd => ({
						id: jd.encryptId,
						encryptId: jd.encryptId,
						title: jd.title || '',
						company: jd.company || '',
						salary: jd.salary || '',
						skills: jd.skills || '',
						description: jd.description || '',
						descriptionPreview: (jd.description || '').slice(0, 300),
						hasDescription: !!(jd.description && jd.description.trim()),
						timestamp: jd.timestamp || 0
					}));
					const jobsBrief = payloadJobs.map((j, idx) => `${idx + 1}. [${j.id}] ${j.title || '未知岗位'} | ${j.company || '未知公司'} | ${j.salary || '薪资未知'} | ${(j.descriptionPreview || '描述为空').replace(/\s+/g, ' ').slice(0, 120)}`).join('\n');

					const res = await nativeFetch(url, {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({
							source: 'vCtrl_V22',
							payloadVersion: '3.0',
							mode: 'batch-review',
							round,
							batchIndex: b + 1,
							totalBatches,
							batchSize,
							jobsCount: payloadJobs.length,
							responseFormat: 'json-array',
							strictResponseSchema: {
								type: 'array',
								item: { id: 'string', apply: 'boolean', reason: 'string' }
							},
							instruction: '请仅返回 JSON 数组。每一项必须包含 id/apply/reason。id 必须等于输入 jobs 中的 id。不要返回单个总判断对象。',
							jobs: payloadJobs,
							jobsBrief
						})
					});
					if (!res.ok) throw new Error(`HTTP ${res.status}`);
					const rawText = await res.text();
					const parsed = tryParseJsonText(rawText);
					const decisions = extractDecisionArray(parsed ?? rawText);
					let globalDecision = null;

					if (!decisions.length && parsed && typeof parsed === 'object') {
						if (Object.prototype.hasOwnProperty.call(parsed, 'apply')) {
							globalDecision = {
								apply: parsed.apply === true || parsed.apply === 'true',
								reason: parsed.reason || '无'
							};
						}
					}

					if (!decisions.length && !globalDecision) throw new Error(`n8n 返回格式无效：未找到决策数组，原始返回片段: ${(rawText || '').slice(0, 220)}`);

					if (globalDecision && batch.length > 1) {
						logMsg(`[n8n 返回不合规] 第 ${round} 轮第 ${b + 1} 批仅返回单个总判断（无id），本批已跳过，请修正 n8n 返回为数组。`, 'warning');
						skipped += batch.length;
						continue;
					}

					const decisionMap = new Map();
					let positionalDecisions = [];
					decisions.forEach(item => {
						if (!item || typeof item !== 'object') return;
						const id = String(item.id || item.encryptId || '').trim();
						if (!id) {
							positionalDecisions.push({
								apply: item.apply === true || item.apply === 'true',
								reason: item.reason || '无'
							});
							return;
						}
						decisionMap.set(id, {
							apply: item.apply === true || item.apply === 'true',
							reason: item.reason || '无'
						});
					});

					for (const jd of batch) {
						const decision = decisionMap.get(String(jd.encryptId)) || positionalDecisions.shift() || globalDecision;
						if (!decision) {
							logMsg(`[大脑决策: ⚪ 缺失] ${jd.title || jd.encryptId} 未返回决策，默认跳过`, 'warning');
							skipped++;
							continue;
						}
						if (decision.apply) {
							logMsg(`[大脑决策: 🟢 同意投递] ${jd.title || jd.encryptId}，理由: ${decision.reason}`, 'success');
							const ok = await window.vCtrl_SendResumeGodMode(jd.encryptId, { moveToHistory: true, archivedBy: 'n8n' });
							if (ok) success++; else fail++;
						} else {
							logMsg(`[大脑决策: 🔴 放弃投递] ${jd.title || jd.encryptId}，理由: ${decision.reason}`, 'warning');
							rejected++;
						}
					}
				} catch (e) {
					const msg = String(e?.message || e || '未知错误');
					if (msg.includes('返回格式无效')) {
						logMsg(`[n8n 返回解析失败] 第 ${round} 轮第 ${b + 1} 批失败: ${msg}`, 'warning');
						skipped += batch.length;
						continue;
					}
					logMsg(`[n8n 通信断开] 第 ${round} 轮第 ${b + 1} 批失败: ${msg}`, 'error');
					fail += batch.length;
					alert('n8n 通信中断，流水线已紧急叫停！请检查 n8n 是否启动。');
					round = loopRounds;
					break;
				}
				if (b < effectiveBatches - 1) await sleep(1000 + Math.random() * 700);
			}
		}

		if (btn) {
			btn.innerText = '🧠 n8n 智能流';
			btn.disabled = false;
		}
		alert(`🎉 n8n 托管任务结束！\n✅ 批准投递: ${success} 份\n🚫 拒绝投递: ${rejected} 份\n⏭️ 跳过(返回不合规/缺失): ${skipped} 份\n❌ 异常中断: ${fail} 份`);
	};

	async function testN8nConnection() {
		const url = (document.getElementById('vctrl-n8n-url')?.value || '').trim();
		if (!url) {
			alert('请先填写 n8n Webhook 地址');
			return;
		}

		const btn = document.getElementById('vctrl-btn-test-n8n');
		if (btn) {
			btn.disabled = true;
			btn.innerText = '测试中...';
		}

		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), 8000);
		try {
			const res = await nativeFetch(url, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ source: 'vCtrl_V21_TEST', type: 'connectivity-test', timestamp: Date.now() }),
				signal: controller.signal
			});
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			logMsg(`[n8n] 连通成功: ${url}`, 'success');
			alert('n8n 连通测试成功');
		} catch (e) {
			logMsg(`[n8n] 连通失败: ${e.message}`, 'error');
			alert(`n8n 连通测试失败: ${e.message}`);
		} finally {
			clearTimeout(timeoutId);
			if (btn) {
				btn.disabled = false;
				btn.innerText = '测试 n8n';
			}
		}
	}

	window.vCtrl_BatchSendResumes = async function() {
		const data = sortJDsByMode(await V19DB.getAllJDs(), state.v19.dataSort || 'rule');
		if (!data.length) return alert('数据库为空，无可投递岗位！');

		const keyword = prompt('【一键批量投递 (无脑模式)】\n不经过 n8n，直接强行投递库中所有岗位。\n请输入过滤关键词（留空则全部投递）：', '');
		if (keyword === null) return;

		const targets = keyword.trim() ? data.filter(jd => (jd.title || '').includes(keyword.trim())) : data;
		if (!targets.length) return alert('没有找到符合规则的岗位！');
		const limit = Math.min(targets.length, Math.max(1, state.v19.forceSendMaxCount || 20));
		const runTargets = targets.slice(0, limit);
		if (!confirm(`⚠️ 警告：即将执行无脑连发指令！匹配 ${targets.length} 个岗位，本次按上限执行 ${runTargets.length} 个。\n\n为防止封号，系统将强制进行随机休眠。是否继续？`)) return;

		const btn = document.getElementById('vctrl-btn-batch-send');
		if (btn) btn.disabled = true;

		let success = 0, fail = 0;
		for (let i = 0; i < runTargets.length; i++) {
			const jd = runTargets[i];
			if (btn) btn.innerText = `投递中 (${i + 1}/${runTargets.length})...`;
			const ok = await window.vCtrl_SendResumeGodMode(jd.encryptId, { archivedBy: 'batch' });
			if (ok) success++; else fail++;
			if (i < runTargets.length - 1) await sleep(2000 + Math.random() * 2000);
		}

		if (btn) {
			btn.innerText = '🚀 批量强投';
			btn.disabled = false;
		}
		alert(`🎉 批量强投完毕！\n成功: ${success} | 失败: ${fail}`);
	};

	window.vCtrl_GenerateAIResumeByRole = async function() {
		const aiCfg = getActiveAIConfig();
		if (!aiCfg || !aiCfg.key || !aiCfg.model) return alert('请先在主面板配置 AI 节点并填写 Key');

		const container = document.getElementById('vctrl-data-content');
		if (!container) return;
		container.innerHTML = `<div style="text-align:center; padding: 60px;"><span style="color:#d2a64a; font-size: 16px;">🚀 正在呼叫大模型 [${aiCfg.name}] 撰写中...</span></div>`;

		const data = await V19DB.getAllJDs();
		if (!data.length) {
			container.innerHTML = '<p style="text-align:center; color:#aaa; margin-top: 50px;">数据库为空，请先汲取 JD。</p>';
			return;
		}

		const roleMap = {};
		data.forEach(jd => {
			const rawTitle = jd.title || '';
			const title = rawTitle.split('(')[0].split('（')[0].split('-')[0].trim() || '未分类岗位';
			if (!roleMap[title]) roleMap[title] = { count: 0, skills: {} };
			roleMap[title].count++;
			if (jd.skills) {
				jd.skills.split(',').forEach(s => {
					const w = s.trim();
					if (w && !CLOUD_STOPWORDS.some(sw => w.includes(sw))) {
						roleMap[title].skills[w] = (roleMap[title].skills[w] || 0) + 1;
					}
				});
			}
		});

		const sortedRoles = Object.keys(roleMap).sort((a, b) => roleMap[b].count - roleMap[a].count).slice(0, 5);
		const promptContext = sortedRoles.map(role => {
			const topSkills = Object.keys(roleMap[role].skills).sort((a, b) => roleMap[role].skills[b] - roleMap[role].skills[a]).slice(0, 8).join('、');
			return `【${role}】(共统计${roleMap[role].count}份真实JD): 核心技术包含 ${topSkills}`;
		}).join('\n');

		const prompt = `你是一位顶级资深猎头。以下是我数据库中排名前5的岗位需求及核心技术栈：\n\n${promptContext}\n\n请针对每个岗位，遵循“动词(Action)+核心技能/工具(Keyword)+可量化的业务结果(Result)”公式，定制3条可写入简历的工作亮点。\n要求：\n1. 贴合岗位技能。\n2. 虚构合理量化结果。\n3. 排版使用 Markdown，每个岗位作大标题 (###)。\n4. 务必全程使用中文（简体）回复，严禁输出无意义英文解释！`;

		try {
			const res = await nativeFetch(aiCfg.endpoint, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${aiCfg.key}` },
				body: JSON.stringify({ model: aiCfg.model, messages: [{ role: 'user', content: prompt }] })
			});
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const json = await res.json();
			if (json.choices && json.choices.length > 0) {
				const safeHtml = json.choices[0].message.content
					.replace(/</g, '&lt;')
					.replace(/>/g, '&gt;')
					.replace(/\*\*(.*?)\*\*/g, '<span style="color:#d29a39; font-weight:bold;">$1</span>')
					.replace(/### (.*)/g, '<div style="color:#d2a64a; font-size:16px; font-weight:bold; margin-top:20px; margin-bottom:10px; border-bottom:1px solid #444; padding-bottom:5px;">📌 $1</div>');
				container.innerHTML = `<div style="display:flex;justify-content:flex-end;margin-bottom:10px;"><button style="background:#6b6f62;color:#fff;border:none;border-radius:4px;padding:6px 12px;cursor:pointer;" onclick="window.vCtrl_RenderDataList()">⬅ 返回列表</button></div><div style="background:#2e332a; border-left:4px solid #d2a64a; padding:15px; border-radius:4px;"><div style="font-weight:bold; margin-bottom:10px;">🤖 数据库深度画像分析结果 (基于 ${aiCfg.name})</div><div style="font-size:14px; line-height:1.6;">${safeHtml}</div></div>`;
			} else {
				container.innerHTML = '<span style="color:red;">API异常</span>';
			}
		} catch (e) {
			container.innerHTML = `<span style="color:red;">请求失败：${e.message}</span>`;
		}
	};

	window.vCtrl_GenerateAIResume = async function(keywordsStr) {
		const aiCfg = getActiveAIConfig();
		if (!aiCfg || !aiCfg.key || !aiCfg.model) return alert('请先配置 AI 节点并填写 Key');
		const container = document.getElementById('vctrl-ai-result-box');
		if (!container) return;
		container.innerHTML = `<span style="color:#d2a64a;">🚀 正在呼叫大模型 [${aiCfg.name}] 思考中...</span>`;
		const prompt = `你是一位资深猎头。高频技术词：${keywordsStr}。\n请遵循“动词+核心技能+量化结果”公式生成3条简历亮点。直接输出3条，每条前加 •。全部使用中文（简体）输出！`;
		try {
			const res = await nativeFetch(aiCfg.endpoint, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${aiCfg.key}` },
				body: JSON.stringify({ model: aiCfg.model, messages: [{ role: 'user', content: prompt }] })
			});
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const json = await res.json();
			container.innerHTML = (json.choices && json.choices.length > 0) ? json.choices[0].message.content : '<span style="color:red;">API异常</span>';
		} catch (e) {
			container.innerHTML = `<span style="color:red;">请求失败：${e.message}</span>`;
		}
	};

	window.vCtrl_DeleteSingleJD = async function(encryptId) {
		if (!encryptId) return;
		if (!confirm(`确定删除该条 JD 数据吗？\nID: ${encryptId}`)) return;
		const ok = await V19DB.deleteJD(encryptId);
		if (!ok) {
			logMsg(`删除失败: ${encryptId}`, 'error');
			return;
		}
		await refreshCounters();
		await renderDataList();
		logMsg(`已删除 JD: ${encryptId}`, 'success');
	};

	window.vCtrl_DeleteSingleHistoryJD = async function(encryptId) {
		if (!encryptId) return;
		if (!confirm(`确定删除该条历史记录吗？\nID: ${encryptId}`)) return;
		if (!v19DB) return;
		const req = v19DB.transaction(V19_STORE_HISTORY, 'readwrite').objectStore(V19_STORE_HISTORY).delete(encryptId);
		req.onsuccess = async () => {
			await renderHistoryList();
			logMsg(`已删除历史记录: ${encryptId}`, 'success');
		};
		req.onerror = () => logMsg(`删除历史记录失败: ${encryptId}`, 'error');
	};

	function getDataSortMode() {
		const mode = document.getElementById('vctrl-data-sort')?.value || state.v19.dataSort || 'rule';
		state.v19.dataSort = mode;
		saveSettings();
		return mode;
	}

	async function renderDataList() {
		const modal = document.getElementById(DATA_MODAL_ID);
		const container = document.getElementById('vctrl-data-content');
		if (!modal || !container) return;
		modal.style.display = 'flex';
		await migrateDeliveredMainToHistory();
		state.v19.dataView = 'active';
		document.getElementById('vctrl-data-view-tag').innerText = '当前视图：主库';
		document.getElementById('vctrl-btn-clear-db').style.display = 'inline-block';
		document.getElementById('vctrl-btn-clear-history').style.display = 'none';
		document.getElementById('vctrl-btn-view-main-data').style.display = 'none';
		document.getElementById('vctrl-btn-view-history').style.display = 'inline-block';

		let data = (await V19DB.getAllJDs()).filter(item => item.deliveryStatus !== 'delivered');
		if (!data.length) {
			container.innerHTML = '<p style="text-align:center; color:#aaa; margin-top: 50px;">数据库为空，快去汲取数据吧~</p>';
			return;
		}
		document.getElementById('vctrl-data-sort').value = state.v19.dataSort || 'rule';
		data = sortJDsByMode(data, getDataSortMode());
		let html = '';
		const renderLimit = Math.min(data.length, 100);
		for (let i = 0; i < renderLimit; i++) {
			const item = data[i];
			const delBtnHtml = `<button style="background:#b7482e;border:none;color:#fff;border-radius:4px;padding:4px 10px;cursor:pointer;" onclick="window.vCtrl_DeleteSingleJD('${item.encryptId}')">🗑 删除</button>`;
			const btnHtml = item.rawJobDetail
				? `<button id="vctrl-send-btn-${item.encryptId}" style="background:#6d7f4a;border:none;color:#fff;border-radius:4px;padding:4px 10px;cursor:pointer;" onclick="window.vCtrl_SendResumeGodMode('${item.encryptId}')">🚀 手动直投</button>`
				: `<button style="background:#555;border:none;color:#fff;border-radius:4px;padding:4px 10px;" disabled>无参数</button>`;

			html += `<div style="background:#2a2a2a;border:1px solid #444;padding:12px;border-radius:6px;margin-bottom:12px;">
				<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
					<span style="font-weight:bold;color:#d2a64a;font-size:14px;">${item.title || '未知岗位'} <span style="color:#aaa;font-size:12px;font-weight:normal;">(${item.company || '未知公司'})</span></span>
					<div style="display:flex;align-items:center;gap:8px;"><span style="font-size:12px;color:#74b45f;">${item.salary || '薪资未知'}</span>${btnHtml}${delBtnHtml}</div>
				</div>
				<div style="font-size:12px;color:#777;margin-top:4px;">技能要求: ${item.skills || '无'}</div>
				<div style="font-size:11px;color:#555;margin-top:2px;">获取时间: ${new Date(item.timestamp || Date.now()).toLocaleString()} | ID: ${item.encryptId}</div>
				<div style="font-size:13px;color:#bbb;white-space:pre-wrap;margin-top:8px;background:#111;padding:10px;border-radius:4px;max-height:90px;overflow-y:auto;line-height:1.6;">${item.description || ''}</div>
			</div>`;
		}
		if (data.length > 100) html += '<div style="text-align:center;color:#aaa;padding:10px;">仅展示最新 100 条数据。完整数据请导出。</div>';
		container.innerHTML = html;
	}
	window.vCtrl_RenderDataList = renderDataList;

	async function renderHistoryList() {
		const modal = document.getElementById(DATA_MODAL_ID);
		const container = document.getElementById('vctrl-data-content');
		if (!modal || !container) return;
		modal.style.display = 'flex';
		state.v19.dataView = 'history';
		document.getElementById('vctrl-data-view-tag').innerText = '当前视图：历史库';
		document.getElementById('vctrl-btn-clear-db').style.display = 'none';
		document.getElementById('vctrl-btn-clear-history').style.display = 'inline-block';
		document.getElementById('vctrl-btn-view-main-data').style.display = 'inline-block';
		document.getElementById('vctrl-btn-view-history').style.display = 'none';

		let data = await V19DB.getAllHistoryJDs();
		if (!data.length) {
			container.innerHTML = '<p style="text-align:center; color:#aaa; margin-top: 50px;">历史库为空。</p>';
			return;
		}
		document.getElementById('vctrl-data-sort').value = state.v19.dataSort || 'rule';
		data = sortJDsByMode(data, getDataSortMode());
		let html = '';
		const renderLimit = Math.min(data.length, 100);
		for (let i = 0; i < renderLimit; i++) {
			const item = data[i];
			html += `<div style="background:#222726;border:1px solid #4a5440;padding:12px;border-radius:6px;margin-bottom:12px;">
				<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
					<span style="font-weight:bold;color:#d2a64a;font-size:14px;">${item.title || '未知岗位'} <span style="color:#aaa;font-size:12px;font-weight:normal;">(${item.company || '未知公司'})</span></span>
					<div style="display:flex;align-items:center;gap:8px;"><span style="font-size:11px;color:#b9c7a0;background:#293023;border:1px solid #4a5440;border-radius:10px;padding:2px 8px;">历史记录</span><span style="font-size:12px;color:#74b45f;">${item.salary || '薪资未知'}</span><button style="background:#b7482e;border:none;color:#fff;border-radius:4px;padding:4px 10px;cursor:pointer;" onclick="window.vCtrl_DeleteSingleHistoryJD('${item.encryptId}')">🗑 删除</button></div>
				</div>
				<div style="font-size:12px;color:#777;margin-top:4px;">技能要求: ${item.skills || '无'}</div>
				<div style="font-size:11px;color:#8a8a8a;margin-top:2px;">获取时间: ${new Date(item.timestamp || Date.now()).toLocaleString()} | 归档时间: ${new Date(item.archivedAt || Date.now()).toLocaleString()} | ID: ${item.encryptId}</div>
				<div style="font-size:13px;color:#bbb;white-space:pre-wrap;margin-top:8px;background:#111;padding:10px;border-radius:4px;max-height:90px;overflow-y:auto;line-height:1.6;">${item.description || ''}</div>
			</div>`;
		}
		if (data.length > 100) html += '<div style="text-align:center;color:#aaa;padding:10px;">仅展示最新 100 条历史记录。</div>';
		container.innerHTML = html;
	}

	async function renderWordCloud() {
		const container = document.getElementById('vctrl-data-content');
		if (!container) return;
		container.innerHTML = '<p style="text-align:center; color:#aaa;">正在深度分析技能栈与提炼高频词...</p>';

		const data = await V19DB.getAllJDs();
		if (!data.length) {
			container.innerHTML = '<p style="text-align:center; color:#aaa; margin-top: 50px;">数据库为空，无法生成</p>';
			return;
		}

		const counts = {};
		let maxCount = 0;
		data.forEach(jd => {
			if (!jd.skills) return;
			jd.skills.split(',').forEach(s => {
				const word = s.trim();
				if (word && !CLOUD_STOPWORDS.some(sw => word.includes(sw))) {
					counts[word] = (counts[word] || 0) + 1;
					if (counts[word] > maxCount) maxCount = counts[word];
				}
			});
		});

		const sortedWords = Object.keys(counts).map(k => ({ text: k, count: counts[k] })).sort((a, b) => b.count - a.count);
		if (!sortedWords.length) {
			container.innerHTML = '<p style="text-align:center; color:#aaa;">无有效硬核技能标签。</p>';
			return;
		}

		const colors = ['#6d7f4a', '#d2a64a', '#a8732a', '#b7482e', '#8b7452', '#8e9c66', '#5f6c48', '#b48a42'];
		let html = `<div style="text-align:center; margin-bottom: 15px; color:#aaa; font-size:12px;">分析了 ${data.length} 份 JD，提取到 <span style="color:#d2a64a; font-weight:bold;">${sortedWords.length}</span> 个核心技术栈。</div><div style="display:flex;flex-wrap:wrap;gap:12px;padding:20px;justify-content:center;align-items:center;line-height:1.5;background:#111;border-radius:8px;border:1px solid #333;">`;
		sortedWords.forEach(w => {
			const fontSize = 12 + (w.count / Math.max(maxCount, 1)) * 24;
			const color = colors[Math.floor(Math.random() * colors.length)];
			html += `<span style="display:inline-block;font-size:${fontSize.toFixed(1)}px;color:${color};font-weight:bold;" title="被需求频次: ${w.count} 次">${w.text}</span>`;
		});
		html += '</div>';

		const topWords = sortedWords.slice(0, 10).map(w => w.text).join(', ');
		html = `<div style="display:flex;justify-content:flex-end;margin-bottom:10px;"><button style="background:#6b6f62;color:#fff;border:none;border-radius:4px;padding:6px 12px;cursor:pointer;" onclick="window.vCtrl_RenderDataList()">⬅ 返回列表</button></div>` + html;
		html += `<div style="background:#2e332a;border-left:4px solid #d2a64a;padding:15px;border-radius:4px;margin-top:20px;"><div style="display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:10px;"><span style="font-weight:bold;">🤖 AI 简历亮点重构指导</span><button style="background:#8a6a2e;color:#fff;border:none;border-radius:4px;padding:6px 12px;cursor:pointer;" onclick="window.vCtrl_GenerateAIResume('${topWords}')">基于高频词生成</button></div><div style="background:#111;color:#bdc3c7;font-size:13px;padding:15px;border-radius:4px;border:1px solid #444;white-space:pre-wrap;" id="vctrl-ai-result-box">点击右上角按钮，AI 将根据当前提取的高频技术栈撰写 STAR 亮点。</div></div>`;
		container.innerHTML = html;
	}

	function openAIConfigModal(isNew = false) {
		const modal = document.getElementById(AI_CFG_MODAL_ID);
		if (!modal) return;
		modal.style.display = 'flex';
		modal.dataset.mode = isNew ? 'new' : 'edit';

		const nameEl = document.getElementById('vctrl-cfg-name');
		const keyEl = document.getElementById('vctrl-cfg-key');
		const modelEl = document.getElementById('vctrl-cfg-model');
		const delBtn = document.getElementById('vctrl-btn-del-ai-cfg');

		if (!nameEl || !keyEl || !modelEl || !delBtn) return;
		if (isNew) {
			nameEl.value = '';
			keyEl.value = '';
			modelEl.value = '';
			delBtn.style.display = 'none';
			return;
		}

		const current = getActiveAIConfig();
		if (!current) return;
		nameEl.value = current.name || '';
		keyEl.value = current.key || '';
		modelEl.value = current.model || '';
		delBtn.style.display = 'block';
	}

	function saveAIConfig() {
		const modal = document.getElementById(AI_CFG_MODAL_ID);
		const name = (document.getElementById('vctrl-cfg-name')?.value || '').trim();
		const key = (document.getElementById('vctrl-cfg-key')?.value || '').trim();
		const model = (document.getElementById('vctrl-cfg-model')?.value || '').trim();
		if (!name || !key || !model) return alert('请将表单填写完整');

		const endpoint = 'https://openrouter.ai/api/v1/chat/completions';
		if (modal?.dataset.mode === 'new') {
			const newId = 'ai_' + Date.now();
			state.v19.aiProfiles.push({ id: newId, name, endpoint, key, model });
			state.v19.currentProfileId = newId;
		} else {
			const idx = state.v19.aiProfiles.findIndex(p => p.id === state.v19.currentProfileId);
			if (idx > -1) state.v19.aiProfiles[idx] = { id: state.v19.currentProfileId, name, endpoint, key, model };
		}

		saveSettings();
		renderAIProfileSelect();
		if (modal) modal.style.display = 'none';
		logMsg('AI 节点配置已更新', 'success');
	}

	function toggleSpiderUI(mode) {
		const start = document.getElementById('vctrl-btn-start-fetch');
		const run = document.getElementById('vctrl-running-controls');
		const pause = document.getElementById('vctrl-btn-pause-fetch');
		if (!start || !run || !pause) return;
		if (mode === 'idle') {
			start.style.display = 'block';
			run.style.display = 'none';
		} else if (mode === 'running') {
			start.style.display = 'none';
			run.style.display = 'flex';
			pause.innerText = '⏸️ 暂停';
		} else {
			pause.innerText = '▶️ 恢复';
		}
	}

	// ======================== Events ========================
	function bindEvents() {
		const panel = document.getElementById(PANEL_ID);
		if (!panel) return;
		if (panel.dataset.vctrlBound === '1') return;
		panel.dataset.vctrlBound = '1';

		panel.querySelectorAll('.vctrl-tab').forEach(t => {
			t.addEventListener('click', () => switchTab(t.getAttribute('data-tab')));
		});

		document.getElementById('vctrl-btn-save-settings')?.addEventListener('click', async () => {
			syncStateFromForm();
			await saveSettings();
			document.querySelectorAll('.job-card-new').forEach(c => c.classList.remove('vctrl-v21-processed', 'vctrl-v21-blocked'));
			processJobCardsForManual();
			logMsg('设置已写入数据库，下次打开自动恢复。', 'success');
		});

		document.getElementById('vctrl-btn-open-filter-cfg')?.addEventListener('click', () => {
			renderFilterConfigModal();
			document.getElementById(FILTER_MODAL_ID).style.display = 'flex';
		});
		document.getElementById('vctrl-btn-save-filter-cfg')?.addEventListener('click', saveFilterConfigModal);
		document.getElementById('vctrl-btn-close-filter-cfg')?.addEventListener('click', () => {
			document.getElementById(FILTER_MODAL_ID).style.display = 'none';
		});

		document.getElementById('vctrl-btn-apply-filter')?.addEventListener('click', () => executeFilterAction(false));
		document.getElementById('vctrl-btn-clear-filter')?.addEventListener('click', () => executeFilterAction(true));
		document.getElementById('vctrl-btn-select-all')?.addEventListener('click', () => document.querySelectorAll('.vctrl-checkbox').forEach(cb => { cb.checked = true; }));
		document.getElementById('vctrl-btn-clear-all')?.addEventListener('click', () => document.querySelectorAll('.vctrl-checkbox').forEach(cb => { cb.checked = false; }));
		document.getElementById('vctrl-btn-apply')?.addEventListener('click', executeManualApply);

		document.getElementById('vctrl-btn-start-fetch')?.addEventListener('click', executeSpider);
		document.getElementById('vctrl-btn-stop-fetch')?.addEventListener('click', () => { shouldStop = true; logMsg('正在终止任务...', 'warning'); });
		document.getElementById('vctrl-btn-pause-fetch')?.addEventListener('click', () => {
			isPaused = !isPaused;
			toggleSpiderUI(isPaused ? 'paused' : 'running');
		});
		document.getElementById('vctrl-btn-view-data')?.addEventListener('click', renderDataList);
		document.getElementById('vctrl-btn-view-history')?.addEventListener('click', renderHistoryList);
		document.getElementById('vctrl-btn-view-main-data')?.addEventListener('click', renderDataList);
		document.getElementById('vctrl-data-sort')?.addEventListener('change', async () => {
			state.v19.dataSort = document.getElementById('vctrl-data-sort')?.value || 'rule';
			await saveSettings();
			if (state.v19.dataView === 'history') await renderHistoryList();
			else await renderDataList();
		});
		document.getElementById('vctrl-btn-close-data-modal')?.addEventListener('click', () => {
			document.getElementById(DATA_MODAL_ID).style.display = 'none';
		});
		document.getElementById('vctrl-btn-export-json')?.addEventListener('click', async () => {
			const data = await V19DB.getAllJDs();
			if (!data.length) return logMsg('导出失败：数据库为空', 'error');
			const a = document.createElement('a');
			a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
			a.download = `vCtrl_JD数据导出_${Date.now()}.json`;
			a.click();
		});
		document.getElementById('vctrl-btn-clear-db')?.addEventListener('click', async () => {
			if (!confirm('警告：清空所有已汲取数据不可恢复！确定吗？')) return;
			await V19DB.clearAllJDs();
			await refreshCounters();
			await renderDataList();
			logMsg('数据库已清空', 'warning');
		});
		document.getElementById('vctrl-btn-clear-history')?.addEventListener('click', async () => {
			if (!confirm('警告：清空所有历史记录不可恢复！确定吗？')) return;
			await V19DB.clearHistoryJDs();
			await renderHistoryList();
			logMsg('历史库已清空', 'warning');
		});
		document.getElementById('vctrl-btn-n8n-send')?.addEventListener('click', window.vCtrl_N8nAutoDelivery);
		document.getElementById('vctrl-btn-batch-send')?.addEventListener('click', window.vCtrl_BatchSendResumes);
		document.getElementById('vctrl-btn-test-n8n')?.addEventListener('click', testN8nConnection);
		document.getElementById('vctrl-btn-view-cloud')?.addEventListener('click', renderWordCloud);
		document.getElementById('vctrl-btn-view-ai-role')?.addEventListener('click', window.vCtrl_GenerateAIResumeByRole);

		document.getElementById('vctrl-ai-profile-select')?.addEventListener('change', async (e) => {
			if (e.target.value === 'ADD_NEW') {
				e.target.value = state.v19.currentProfileId;
				openAIConfigModal(true);
				return;
			}
			state.v19.currentProfileId = e.target.value;
			await saveSettings();
		});
		document.getElementById('vctrl-btn-ai-cfg-open')?.addEventListener('click', () => openAIConfigModal(false));
		document.getElementById('vctrl-btn-close-ai-cfg')?.addEventListener('click', () => {
			document.getElementById(AI_CFG_MODAL_ID).style.display = 'none';
		});
		document.getElementById('vctrl-btn-save-ai-cfg')?.addEventListener('click', saveAIConfig);
		document.getElementById('vctrl-btn-del-ai-cfg')?.addEventListener('click', async () => {
			if ((state.v19.aiProfiles || []).length <= 1) return alert('必须保留至少一个配置');
			if (!confirm('确定删除此模型配置？')) return;
			state.v19.aiProfiles = state.v19.aiProfiles.filter(p => p.id !== state.v19.currentProfileId);
			state.v19.currentProfileId = state.v19.aiProfiles[0].id;
			await saveSettings();
			renderAIProfileSelect();
			document.getElementById(AI_CFG_MODAL_ID).style.display = 'none';
		});

		document.getElementById('vctrl-btn-unload')?.addEventListener('click', () => {
			if (confirm('确定卸载 V21 吗？')) window.vCtrl_Unload_v21();
		});
		document.getElementById('vctrl-btn-toggle')?.addEventListener('click', async () => {
			const p = document.getElementById(PANEL_ID);
			state.uiState.collapsed = !p.classList.contains('collapsed');
			p.classList.toggle('collapsed', state.uiState.collapsed);
			await saveSettings();
		});

		let drag = false, sx = 0, sy = 0, sl = 0, st = 0;
		eventRefs.down = (e) => {
			if (e.target.tagName.toLowerCase() === 'button') return;
			drag = true;
			sx = e.clientX; sy = e.clientY;
			const r = panel.getBoundingClientRect();
			sl = r.left; st = r.top;
		};
		eventRefs.move = (e) => {
			if (!drag) return;
			panel.style.left = sl + (e.clientX - sx) + 'px';
			panel.style.top = st + (e.clientY - sy) + 'px';
			panel.style.right = 'auto'; panel.style.bottom = 'auto';
		};
		eventRefs.up = async () => {
			if (!drag) return;
			drag = false;
			state.uiState.x = panel.style.left;
			state.uiState.y = panel.style.top;
			await saveSettings();
		};
		document.getElementById('vctrl-drag')?.addEventListener('mousedown', eventRefs.down);
		document.addEventListener('mousemove', eventRefs.move);
		document.addEventListener('mouseup', eventRefs.up);

		const autoSave = async () => {
			syncStateFromForm();
			await saveSettings();
		};
		['vctrl-selective-mode','vctrl-auto-filter-toggle','vctrl-fetch-mode','vctrl-fetch-deep-blacklist','vctrl-delivery-policy','vctrl-n8n-url','vctrl-n8n-loop-enabled','vctrl-n8n-loop-rounds','vctrl-force-send-max','vctrl-global-whitelist','vctrl-global-blacklist','vctrl-setting-shared-max','vctrl-setting-shared-delay']
			.forEach(id => {
				const el = document.getElementById(id);
				if (!el) return;
				el.addEventListener('change', autoSave);
				el.addEventListener('input', autoSave);
			});
	}

	function injectUI() {
		if (document.getElementById(PANEL_ID)) return;

		const style = document.createElement('style');
		style.id = STYLE_ID;
		style.textContent = `
			#${PANEL_ID}{position:fixed;right:20px;bottom:20px;width:380px;min-height:520px;max-height:88vh;background:#171a16;color:#ecefe7;border:1px solid #3f4738;border-radius:10px;z-index:999999;display:flex;flex-direction:column;overflow:hidden;resize:both;box-shadow:0 8px 24px rgba(0,0,0,.45);font-family:sans-serif}
			#${PANEL_ID}.collapsed .vctrl-body{display:none}
			#${PANEL_ID} .vctrl-header{padding:10px;background:#262b22;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #3f4738;cursor:move}
			#${PANEL_ID} .vctrl-body{padding:10px;display:flex;flex-direction:column;gap:8px;overflow:auto}
			#${PANEL_ID} .tabs{display:flex;gap:6px}
			#${PANEL_ID} .vctrl-tab{flex:1;border:1px solid #4a5440;background:#222821;color:#cfd6c1;border-radius:6px;padding:6px;cursor:pointer}
			#${PANEL_ID} .vctrl-tab.active{background:#d2a64a;color:#2f2206;border-color:#d2a64a;font-weight:bold}
			#${PANEL_ID} .vctrl-section{display:none}
			#${PANEL_ID} .vctrl-section.active{display:block}
			#${PANEL_ID} .blk{background:#1f241d;border:1px solid #3f4738;border-radius:8px;padding:8px;margin-bottom:8px}
			#${PANEL_ID} .tit{font-size:12px;color:#d5c087;margin-bottom:6px;font-weight:bold}
			#${PANEL_ID} input,#${PANEL_ID} select{width:100%;padding:6px;background:#2a3026;color:#f2f5ea;border:1px solid #4d5844;border-radius:5px;box-sizing:border-box}
			#${PANEL_ID} input[type="checkbox"]{width:16px;height:16px;padding:0;border:none;vertical-align:middle;accent-color:#6d7f4a;cursor:pointer}
			#${PANEL_ID} label{display:flex;align-items:center;gap:8px}
			#${PANEL_ID} button{background:#6d7f4a;color:#fff;border:none;border-radius:5px;padding:6px 10px;cursor:pointer}
			#${PANEL_ID} button.danger{background:#b7261b}
			#${PANEL_ID} button.ok{background:#4f8f47}
			#${PANEL_ID} button.gray{background:#6b6f62}
			#${PANEL_ID} button.info{background:#8a6a2e}
			#${PANEL_ID} button.warning{background:#a8732a}
			#${PANEL_ID} button.purple{background:#6a5a88}
			#${PANEL_ID} button.pink{background:#9a5a63}
			#${PANEL_ID} .row{display:flex;gap:6px;align-items:center}
			#${PANEL_ID} .row > *{flex:1}
			#vctrl-log{background:#10130f;border:1px solid #3f4738;border-radius:6px;height:120px;overflow:auto;padding:6px;font-family:monospace;font-size:11px;line-height:1.45}
			.vctrl-modal{position:fixed;inset:0;background:rgba(0,0,0,.68);display:none;align-items:center;justify-content:center;z-index:1000000}
			.vctrl-modal .box{width:520px;max-height:80vh;background:#1b2019;color:#ecefe7;border:1px solid #3f4738;border-radius:8px;display:flex;flex-direction:column}
			.vctrl-modal .hd{padding:10px;border-bottom:1px solid #3f4738;display:flex;justify-content:space-between;align-items:center}
			.vctrl-modal .bd{padding:10px;overflow:auto}
			.vctrl-modal .fg{margin-bottom:10px}
			.vctrl-modal .tt{font-size:12px;color:#d5c087;margin-bottom:6px}
			.vctrl-modal .tags{display:flex;flex-wrap:wrap;gap:6px}
			.vctrl-modal .tag{padding:4px 8px;background:#2a3026;border:1px solid #4d5844;border-radius:5px;cursor:pointer;font-size:12px}
			.vctrl-modal .tag.active{background:#d2a64a;border-color:#d2a64a;color:#2f2206;font-weight:bold}
			.vctrl-data-box{width:900px;max-height:86vh;background:#1f241d;color:#ecefe7;border:1px solid #3f4738;border-radius:8px;display:flex;flex-direction:column}
			.vctrl-data-header{padding:10px;border-bottom:1px solid #3f4738;display:flex;justify-content:space-between;align-items:center;gap:8px}
			.vctrl-data-actions{display:flex;gap:8px;flex-wrap:wrap}
			.vctrl-data-content{padding:10px;overflow:auto}
			.vctrl-ai-cfg-box{width:420px;max-height:86vh;background:#1f241d;color:#ecefe7;border:1px solid #3f4738;border-radius:8px;display:flex;flex-direction:column}
			.vctrl-ai-cfg-body{padding:12px;display:flex;flex-direction:column;gap:8px}
		`;
		document.head.appendChild(style);

		const panel = document.createElement('div');
		panel.id = PANEL_ID;
		panel.innerHTML = `
			<div class="vctrl-header" id="vctrl-drag">
				<div>
					<div style="font-weight:bold;color:#d2a64a;">vCtrl v${APP_VERSION}</div>
					<div id="vctrl-apply-counter" style="font-size:12px;color:#5beaa7;">已投 0（今 0）</div>
				</div>
				<div>
					<button id="vctrl-btn-toggle" style="background:transparent;border:1px solid #526387;padding:2px 6px;">_</button>
					<button id="vctrl-btn-unload" class="danger" style="padding:2px 6px;">X</button>
				</div>
			</div>
			<div class="vctrl-body">
				<div class="tabs">
					<button class="vctrl-tab" data-tab="manual">手动投递</button>
					<button class="vctrl-tab" data-tab="spider">爬取汲取</button>
					<button class="vctrl-tab" data-tab="settings">设置</button>
				</div>

				<div class="vctrl-section" id="vctrl-section-manual">
					<div class="blk">
						<div class="tit">V5 手动投递板块</div>
						<div class="row" style="margin-bottom:6px;"><div>雷达捕获: <span id="vctrl-radar-count-spider">0</span></div><div>纯净JD: <span id="vctrl-jd-total-spider">0</span></div></div>
						<label style="font-size:12px;"><input type="checkbox" id="vctrl-auto-filter-toggle"> 开局自动筛选</label>
						<div class="row" style="margin-top:6px;"><button id="vctrl-btn-open-filter-cfg">配置筛选规则</button><button id="vctrl-btn-apply-filter">应用筛选</button><button id="vctrl-btn-clear-filter" class="danger">清除条件</button></div>
						<hr style="border-color:#2f4260;">
						<label style="font-size:12px;"><input type="checkbox" id="vctrl-selective-mode"> 勾选投递模式</label>
						<div class="row" style="margin-top:6px;"><button id="vctrl-btn-select-all" class="ok">全选</button><button id="vctrl-btn-clear-all" class="gray">清空</button></div>
						<button id="vctrl-btn-apply" class="ok" style="width:100%;margin-top:6px;font-weight:bold;">🚀 一键执行投递</button>
					</div>
				</div>

				<div class="vctrl-section" id="vctrl-section-spider">
					<div class="blk">
						<div class="tit">V19 爬取板块</div>
						<div class="row" style="margin-bottom:6px;"><div>雷达捕获: <span id="vctrl-radar-count">0</span></div><div>纯净JD: <span id="vctrl-jd-total">0</span></div></div>
						<div class="row" style="margin-top:6px;"><button id="vctrl-btn-start-fetch" class="ok">⚡ 开始智能汲取</button><button id="vctrl-btn-view-data" class="warning">打开数据库大盘</button></div>
						<div id="vctrl-running-controls" class="row" style="display:none;margin-top:6px;">
							<button id="vctrl-btn-stop-fetch" class="danger">⏹️ 终止任务</button>
							<button id="vctrl-btn-pause-fetch">⏸️ 暂停</button>
						</div>
						<div style="font-size:12px;color:#9fb2d8;margin-top:8px;">汲取日志终端：</div>
						<div id="vctrl-log"></div>
						<hr style="border-color:#2f4260;margin-top:10px;">
						<div class="row"><select id="vctrl-fetch-mode"><option value="all">全量无差别汲取</option><option value="rule">仅限白名单匹配</option></select></div>
						<input id="vctrl-fetch-deep-blacklist" type="text" placeholder="深层排雷词" style="margin-top:6px;">
						<div style="margin-top:6px;">
							<select id="vctrl-delivery-policy">
								<option value="keep-last">投递后保留并置底</option>
								<option value="delete">投递后自动清理</option>
							</select>
						</div>
						<div style="margin-top:8px;background:#1b2118;padding:8px;border:1px solid #3f4738;border-radius:6px;">
							<div style="font-size:12px;color:#c8b486;margin-bottom:6px;">大模型节点</div>
							<div class="row"><select id="vctrl-ai-profile-select"></select><button id="vctrl-btn-ai-cfg-open" class="info">⚙️ 管理</button></div>
						</div>
						<div style="margin-top:8px;background:#1b2118;padding:8px;border:1px solid #3f4738;border-radius:6px;">
							<div style="font-size:12px;color:#cdb07a;margin-bottom:6px;">n8n Webhook 天线地址</div>
							<input id="vctrl-n8n-url" type="text" placeholder="http://localhost:5678/webhook-test/...">
							<div class="row" style="margin-top:6px;"><button id="vctrl-btn-test-n8n" class="info">测试 n8n</button></div>
						</div>
					</div>
				</div>

				<div class="vctrl-section" id="vctrl-section-settings">
					<div class="blk">
						<div class="tit">统一设置（数据库持久化）</div>
						<div style="font-size:12px;color:#9fb2d8;line-height:1.5;">全局白/黑名单会同时作用于手动与爬取；20/1200 等参数也统一在此配置。</div>
						<div class="row" style="margin-top:8px;"><input id="vctrl-global-whitelist" type="text" placeholder="全局白名单（逗号分隔）"><input id="vctrl-global-blacklist" type="text" placeholder="全局标题黑名单（逗号分隔）"></div>
						<div style="margin-top:8px;font-size:12px;color:#cdb07a;">这一行参数同时作用于 手动投递 与 爬取汲取</div>
						<div class="row" style="margin-top:8px;"><input id="vctrl-setting-shared-max" type="number" min="1" max="500" placeholder="单次上限（通用）"><input id="vctrl-setting-shared-delay" type="number" min="0" max="5000" placeholder="间隔(ms)（通用）"></div>
						<div style="margin-top:10px;font-size:12px;color:#cdb07a;">n8n 托管投递规则（可选）</div>
						<label style="font-size:12px;margin-top:6px;"><input type="checkbox" id="vctrl-n8n-loop-enabled"> 循环到结束（默认关闭，关闭时仅发送1批）</label>
						<div class="row" style="margin-top:8px;"><input id="vctrl-n8n-loop-rounds" type="number" min="1" max="20" placeholder="托管轮次（默认1）"><input id="vctrl-force-send-max" type="number" min="1" max="500" placeholder="批量强投单次上限"></div>
						<button id="vctrl-btn-save-settings" class="ok" style="width:100%;margin-top:8px;font-weight:bold;">💾 保存当前配置到数据库</button>
					</div>
				</div>
			</div>
		`;
		document.body.appendChild(panel);

		const filterModal = document.createElement('div');
		filterModal.id = FILTER_MODAL_ID;
		filterModal.className = 'vctrl-modal';
		filterModal.innerHTML = `
			<div class="box">
				<div class="hd"><span>编辑筛选偏好</span><button id="vctrl-btn-close-filter-cfg" class="danger">关闭</button></div>
				<div class="bd" id="vctrl-filter-modal-body"></div>
				<div class="hd" style="justify-content:flex-end;"><button id="vctrl-btn-save-filter-cfg" class="ok">保存到数据库</button></div>
			</div>
		`;
		document.body.appendChild(filterModal);

		const dataModal = document.createElement('div');
		dataModal.id = DATA_MODAL_ID;
		dataModal.className = 'vctrl-modal';
		dataModal.innerHTML = `
			<div class="vctrl-data-box">
				<div class="vctrl-data-header">
					<div style="font-weight:bold;color:#d2a64a;">🗄️ 数据库大盘与中央指挥部 <span id="vctrl-data-view-tag" style="font-size:12px;color:#aaa;font-weight:normal;">当前视图：主库</span></div>
					<div class="vctrl-data-actions">
						<select id="vctrl-data-sort" style="max-width:140px;"><option value="rule">规则排序</option><option value="name">按名字</option><option value="time">按获取时间</option></select>
						<button id="vctrl-btn-view-history" class="gray">查看历史</button>
						<button id="vctrl-btn-view-main-data" class="gray" style="display:none;">查看主库</button>
						<button id="vctrl-btn-n8n-send" class="purple">🧠 n8n 智能流</button>
						<button id="vctrl-btn-batch-send" class="pink">🚀 批量强投</button>
						<button id="vctrl-btn-view-cloud" class="warning">大盘词云</button>
						<button id="vctrl-btn-view-ai-role" class="info">分岗 AI</button>
						<button id="vctrl-btn-export-json" class="ok">导出 JSON</button>
						<button id="vctrl-btn-clear-db" class="danger">清空</button>
						<button id="vctrl-btn-clear-history" class="danger" style="display:none;">清空历史</button>
						<button id="vctrl-btn-close-data-modal" class="danger">关闭</button>
					</div>
				</div>
				<div class="vctrl-data-content" id="vctrl-data-content"><p style="text-align:center;color:#aaa;margin-top:50px;">查询中...</p></div>
			</div>
		`;
		document.body.appendChild(dataModal);

		const aiCfgModal = document.createElement('div');
		aiCfgModal.id = AI_CFG_MODAL_ID;
		aiCfgModal.className = 'vctrl-modal';
		aiCfgModal.innerHTML = `
			<div class="vctrl-ai-cfg-box">
				<div class="vctrl-data-header">
					<div style="font-weight:bold;color:#d2a64a;">⚙️ 添加/编辑 AI 模型</div>
					<button id="vctrl-btn-close-ai-cfg" class="danger">关闭</button>
				</div>
				<div class="vctrl-ai-cfg-body">
					<label style="font-size:12px;color:#c8b486;">节点别名</label>
					<input type="text" id="vctrl-cfg-name" placeholder="例如：免费版 Gemini">
					<label style="font-size:12px;color:#c8b486;">OpenRouter API Key</label>
					<input type="password" id="vctrl-cfg-key" placeholder="sk-or-v1-...">
					<label style="font-size:12px;color:#c8b486;">Model 全称</label>
					<input type="text" id="vctrl-cfg-model" placeholder="如: google/gemini-2.5-flash-free">
					<div class="row" style="margin-top:8px;"><button id="vctrl-btn-save-ai-cfg" class="info">保存并应用</button><button id="vctrl-btn-del-ai-cfg" class="danger" style="display:none;">删除此项</button></div>
				</div>
			</div>
		`;
		document.body.appendChild(aiCfgModal);
	}

	// ======================== Unload & Init ========================
	window.vCtrl_Unload_v21 = function() {
		delete window[GLOBAL_INIT_KEY];
		document.getElementById(PANEL_ID)?.remove();
		document.getElementById(STYLE_ID)?.remove();
		document.getElementById(FILTER_MODAL_ID)?.remove();
		document.getElementById(DATA_MODAL_ID)?.remove();
		document.getElementById(AI_CFG_MODAL_ID)?.remove();
		document.getElementById('vctrl-v21-silent-style')?.remove();
		if (cardObserver) { cardObserver.disconnect(); cardObserver = null; }
		if (eventRefs.move) document.removeEventListener('mousemove', eventRefs.move);
		if (eventRefs.up) document.removeEventListener('mouseup', eventRefs.up);
		window.fetch = nativeFetch;
		XMLHttpRequest.prototype.send = nativeXhrSend;
		if (v5DB) { v5DB.close(); v5DB = null; }
		if (v19DB) { v19DB.close(); v19DB = null; }
		delete window.vCtrl_SendResumeGodMode;
		delete window.vCtrl_N8nAutoDelivery;
		delete window.vCtrl_BatchSendResumes;
		delete window.vCtrl_GenerateAIResumeByRole;
		delete window.vCtrl_GenerateAIResume;
		delete window.vCtrl_DeleteSingleJD;
		delete window.vCtrl_RenderDataList;
		delete window.vCtrl_DeleteSingleHistoryJD;
		delete window.vCtrl_Unload_v21;
	};

	async function init() {
		try {
			if (window[GLOBAL_INIT_KEY]) return;
			window[GLOBAL_INIT_KEY] = true;
			injectMainWorldRadar();
			await Promise.all([V5DB.init(), V19DB.init()]);
			const migrated = await migrateDeliveredMainToHistory();
			await loadSettings();
			injectUI();
			applyPanelState();
			syncFormFromState();
			bindEvents();
			switchTab(state.activeTab || 'manual');
			initCardObserver();
			startAutoFilter();
			await refreshCounters();
			if (migrated > 0) {
				logMsg(`兼容迁移完成：${migrated} 条已投递记录已转入历史库。`, 'success');
			}
			logMsg(`v${APP_VERSION} 启动成功：V5 手动板块 + V19 爬取板块。`, 'success');
		} catch (e) {
			console.error('[vCtrl V21] 初始化失败', e);
		}
	}

	setTimeout(init, 700);
})();
