// ============================================================
// RDMex — 가상폴더 UI (분류는 브라우저 로컬 전용, RD 데이터는 그대로)
// ============================================================
const API_BASE = "https://api.real-debrid.com/rest/1.0";
const UNRESTRICT_CONCURRENCY = 4;
const STORE_FOLDERS = "rdmex_folders_v1";
const STORE_HIDDEN  = "rdmex_hidden_v1";
const TOKEN_KEY     = "rdToken";
const MIN_FILE_SIZE_BYTES = 500 * 1024 * 1024;

let refreshTimer = null;
let fastRefreshCount = 0;
let slowRefreshCount = 0;

/* ---------------- 기반 유틸 ---------------- */
function esc(v) { return String(v === undefined || v === null ? "" : v).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
function escAttr(v) { return esc(v); }
function safeUrl(v) {
    const raw = String(v === undefined || v === null ? "" : v).trim();
    if (!raw) return "";
    try { const u = new URL(raw, window.location.href); return (u.protocol === "http:" || u.protocol === "https:") ? u.href : ""; } catch (e) { return ""; }
}
async function mapLimit(items, limit, fn) {
    const results = new Array(items.length);
    let cursor = 0;
    const workers = [];
    const workerCount = Math.max(1, Math.min(limit, items.length));
    for (let w = 0; w < workerCount; w++) {
        workers.push((async function () {
            while (true) {
                const i = cursor++;
                if (i >= items.length) return;
                results[i] = await fn(items[i], i);
            }
        })());
    }
    await Promise.all(workers);
    return results;
}
function formatSize(bytes) {
    if (!bytes) return "0 B";
    const k = 1024, sizes = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.min(sizes.length - 1, Math.floor(Math.log(bytes) / Math.log(k)));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}
function getStatusClass(status) {
    return { waiting_files_selection: "b-wait", queued: "b-queue", downloading: "b-down", downloaded: "b-done", error: "b-err", dead: "b-err" }[status] || "b-queue";
}
function getStatusText(status) {
    return { waiting_files_selection: "파일 선택 대기", queued: "대기 중", downloading: "다운로드 중", downloaded: "완료", error: "오류", dead: "데드 토렌트" }[status] || status;
}
function isMobileDevice() {
    return ('ontouchstart' in window || navigator.maxTouchPoints > 0) && /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
}
const NARROW = window.matchMedia("(max-width:900px)");

function log(message, type) {
    const el = document.getElementById("statusLog");
    if (!el) return;
    const time = new Date().toLocaleTimeString();
    const icon = type === "error" ? "fa-times-circle text-red-500" : type === "success" ? "fa-check-circle text-green-500"
        : type === "warning" ? "fa-exclamation-triangle text-yellow-500" : "fa-info-circle text-blue-500";
    const entry = document.createElement("div");
    entry.innerHTML = `<span class="text-xs text-gray-500">[${time}]</span> <i class="fas ${icon} ml-2 mr-2"></i> <span>${esc(message)}</span>`;
    el.appendChild(entry);
    el.scrollTop = el.scrollHeight;
}
let toastTimer = null;
function toast(message) {
    const el = document.getElementById("toast");
    if (!el) return;
    el.textContent = message;
    el.classList.add("on");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove("on"); }, 1900);
}
function lum(hex) {
    try {
        const n = parseInt(String(hex).replace("#", ""), 16), r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
        const f = function (v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
        return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    } catch (e) { return 0.5; }
}

/* ---------------- 토큰 ---------------- */
function getToken() { return localStorage.getItem(TOKEN_KEY); }
function saveToken() {
    const input = document.getElementById("apiToken");
    const token = (input.value || "").trim();
    if (!token) { toast("토큰을 입력해주세요"); log("토큰이 비어 있습니다.", "warning"); return; }
    localStorage.setItem(TOKEN_KEY, token);
    input.value = "";
    toast("API 토큰이 저장되었습니다");
    log("API 토큰이 저장되었습니다.", "success");
    testConnection();
}

/* ---------------- API ---------------- */
async function makeApiCall(endpoint, options = {}) {
    const token = getToken();
    if (!token) throw new Error("API 토큰이 설정되지 않았습니다.");
    const url = API_BASE + endpoint;
    const headers = Object.assign({ Authorization: "Bearer " + token }, options.headers || {});
    const finalOptions = Object.assign({}, options, { headers: headers });
    try {
        const response = await fetch(url, finalOptions);
        if (response.status === 204) return null;
        let data = null;
        try { data = await response.json(); } catch (e) { data = null; }
        if (!response.ok) {
            const details = data && data.error ? (data.error_code || "") + " - " + data.error : response.statusText;
            throw new Error("API 오류: " + response.status + " - " + details);
        }
        return data;
    } catch (error) {
        log("API 호출 실패: " + error.message, "error");
        throw error;
    }
}

async function testConnection() {
    const statusEl = document.getElementById("apiStatus");
    const combined = document.getElementById("apiCombined");
    if (statusEl) statusEl.textContent = "확인 중...";
    try {
        const user = await makeApiCall("/user");
        if (statusEl) { statusEl.textContent = "연결됨"; statusEl.classList.add("on"); statusEl.classList.remove("err"); }
        log("API 연결 성공 - 사용자: " + user.username, "success");
        toast("연결 성공! 사용자: " + user.username);
        if (user.type === "premium" && user.expiration) {
            const d = new Date(user.expiration);
            const days = Math.ceil((d - new Date()) / 86400000);
            if (combined) combined.textContent = (days > 0 ? "D-" + days : "만료") + " · " + (user.points || 0) + "P";
            if (days <= 7 && days > 0) toast("프리미엄 만료일이 " + days + "일 남았습니다.");
        } else if (combined) {
            combined.textContent = "프리미엄 아님";
        }
        if (!refreshTimer) startOrResetRefreshCycle();
        return true;
    } catch (e) {
        if (statusEl) { statusEl.textContent = "연결 실패"; statusEl.classList.add("err"); statusEl.classList.remove("on"); }
        toast("연결 실패: " + e.message);
        stopRefreshCycle();
        return false;
    }
}

/* ---------------- 자동 갱신 ---------------- */
function stopRefreshCycle() {
    if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
    fastRefreshCount = 0; slowRefreshCount = 0;
}
function startOrResetRefreshCycle() {
    if (refreshTimer) clearInterval(refreshTimer);
    fastRefreshCount = 5; slowRefreshCount = 11;
    log("자동 갱신 주기 시작.");
    scheduledRefresh();
    refreshTimer = setInterval(scheduledRefresh, 60000);
}
function scheduledRefresh() {
    if (!getToken()) { stopRefreshCycle(); return; }
    if (fastRefreshCount > 0) {
        fastRefreshCount--;
        log(`[자동 갱신] 1분 간격 새로고침 (${fastRefreshCount}회 남음)`);
        refreshTorrents();
        if (fastRefreshCount === 0) {
            log("빠른 갱신 종료. 5분 간격으로 전환.");
            clearInterval(refreshTimer); refreshTimer = null;
            if (slowRefreshCount > 0) refreshTimer = setInterval(scheduledRefresh, 300000);
        }
    } else if (slowRefreshCount > 0) {
        slowRefreshCount--;
        log(`[자동 갱신] 5분 간격 새로고침 (${slowRefreshCount}회 남음)`);
        refreshTorrents();
        if (slowRefreshCount === 0) { log("자동 갱신 종료."); clearInterval(refreshTimer); refreshTimer = null; }
    } else {
        if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
    }
}

/* ============================================================
   가상폴더 (로컬 분류)
   ============================================================ */
const PALETTE = ["#2563eb", "#8b5cf6", "#10b981", "#f59e0b", "#ef4444", "#ec4899", "#14b8a6", "#6366f1", "#0ea5e9", "#84cc16"];
let folderState = loadFolderState();
let selectedFolder = "all";
let pickedId = null;
let hiddenIds = loadHidden();
let torrents = [];

function loadFolderState() {
    try {
        const raw = localStorage.getItem(STORE_FOLDERS);
        if (raw) {
            const parsed = JSON.parse(raw);
            if (parsed && Array.isArray(parsed.folders)) return { folders: parsed.folders, map: parsed.map || {}, seq: parsed.seq || parsed.folders.length + 1 };
        }
    } catch (e) { }
    return { folders: [], map: {}, seq: 1 };
}
function saveFolderState() {
    try { localStorage.setItem(STORE_FOLDERS, JSON.stringify(folderState)); } catch (e) { }
}
function loadHidden() {
    try { const raw = localStorage.getItem(STORE_HIDDEN); if (raw) return new Set(JSON.parse(raw)); } catch (e) { }
    return new Set();
}
function saveHidden() {
    try { localStorage.setItem(STORE_HIDDEN, JSON.stringify([...hiddenIds])); } catch (e) { }
}
function nextFolderColor() {
    const used = new Set(folderState.folders.map(function (f) { return String(f.color).toLowerCase(); }));
    const free = PALETTE.find(function (c) { return !used.has(c.toLowerCase()); });
    if (free) return free;
    const n = folderState.folders.length;
    for (let i = 0; i < 40; i++) {
        const c = "hsl(" + ((n * 47 + i * 61) % 360) + " 62% 52%)";
        if (!used.has(c.toLowerCase())) return c;
    }
    return "hsl(" + ((n * 47) % 360) + " 62% 52%)";
}
function folderById(id) { return folderState.folders.find(function (f) { return f.id === id; }); }
function countOf(fid) { return Object.keys(folderState.map).filter(function (k) { return folderState.map[k] === fid; }).length; }
function addFolder() {
    const color = nextFolderColor();
    const f = { id: "f" + Date.now().toString(36), name: "새 폴더 " + folderState.seq++, color: color };
    folderState.folders.push(f);
    saveFolderState();
    selectedFolder = f.id;
    pickedId = null;
    renderAll();
    log("폴더 '" + f.name + "' 생성 (색상 " + color + ")", "success");
    const box = document.getElementById("folders");
    if (box) box.scrollLeft = box.scrollWidth;
}

/* ============================================================
   렌더
   ============================================================ */
const ICONS = {
    folder: '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4l2 2h9A1.5 1.5 0 0 1 21 9.5v8A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5z"/></svg>',
    pot: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M8 5l11 7-11 7z" fill="currentColor" stroke="none"/></svg>',
    stream: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="14" rx="2"/><path d="M10 9l5 3-5 3z" fill="currentColor" stroke="none"/><path d="M8 21h8"/></svg>',
    rd: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/></svg>',
    down: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11"/><path d="M7 10l5 5 5-5"/><path d="M4 20h16"/></svg>',
    copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/></svg>',
    refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 3v6h-6"/></svg>',
    clean: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M6 6l1 14h10l1-14"/></svg>'
};

function renderFolders() {
    const box = document.getElementById("folders");
    if (!box) return;
    box.innerHTML = "";
    folderState.folders.forEach(function (f) {
        const el = document.createElement("div");
        el.className = "folder" + (selectedFolder === f.id ? " sel" : "");
        el.style.color = f.color;
        el.dataset.id = f.id;
        el.innerHTML = '<div class="frow"><span class="ic">' + ICONS.folder + '</span><span class="cnt">' + countOf(f.id) + '</span></div>' +
                       '<div class="nm" title="' + escAttr(f.name) + '">' + esc(f.name) + '</div>';
        el.addEventListener("click", function () {
            if (el.querySelector("input")) return;
            selectedFolder = f.id; pickedId = null; renderAll();
            log("'" + f.name + "' 폴더 선택 (" + countOf(f.id) + "개)");
        });
        el.addEventListener("contextmenu", function (e) { e.preventDefault(); openCtx(e.clientX, e.clientY, f.id); });
        let lp = null;
        el.addEventListener("pointerdown", function (e) { if (e.pointerType !== "mouse") lp = setTimeout(function () { openCtx(e.clientX, e.clientY, f.id); }, 500); });
        ["pointerup", "pointerleave", "pointermove"].forEach(function (ev) { el.addEventListener(ev, function () { clearTimeout(lp); }); });
        box.appendChild(el);
    });
    if (!folderState.folders.length) {
        const hint = document.createElement("div");
        hint.className = "fx-hint";
        hint.textContent = "폴더 추가로 분류를 시작하세요";
        box.appendChild(hint);
    }
    const btnAll = document.getElementById("btnAll");
    if (btnAll) btnAll.classList.toggle("active", selectedFolder === "all");
}

function currentItems() {
    return torrents.filter(function (t) {
        if (hiddenIds.has(t.id)) return false;
        return selectedFolder === "all" ? !folderState.map[t.id] : folderState.map[t.id] === selectedFolder;
    });
}

function renderList() {
    const head = document.getElementById("listHead");
    const rowsEl = document.getElementById("rows");
    if (!head || !rowsEl) return;
    const f = selectedFolder === "all" ? null : folderById(selectedFolder);
    if (!f && selectedFolder !== "all") { selectedFolder = "all"; return renderList(); }

    document.getElementById("listTitle").textContent = f ? f.name : "목록";
    const items = currentItems();
    const unclassified = torrents.filter(function (t) { return !folderState.map[t.id] && !hiddenIds.has(t.id); }).length;
    document.getElementById("listSub").textContent = f ? items.length + "개" : "미분류 " + unclassified + "개";

    if (f) {
        head.classList.add("on-folder");
        const c = f.color;
        head.style.background = "linear-gradient(90deg, " + c + " 0%, " + c + " 38%, color-mix(in srgb, " + c + " 58%, #ffffff) 100%)";
    } else {
        head.classList.remove("on-folder");
        head.style.background = "";
    }

    rowsEl.innerHTML = "";
    if (!items.length) {
        rowsEl.innerHTML = '<div class="empty"><b>' + (f ? "이 폴더에 담긴 토렌트가 없습니다" : "표시할 토렌트가 없습니다") +
            '</b>' + (f ? "다른 폴더를 선택하거나 목록에서 이동하세요." : "새로고침하거나 마그넷을 추가하세요.") + '</div>';
        syncToolState();
        return;
    }

    items.forEach(function (t) {
        const row = document.createElement("div");
        row.className = "row" + (pickedId === t.id ? " picked" : "");
        row.dataset.row = t.id;
        const pct = typeof t.progress === "number" ? Math.max(0, Math.min(100, t.progress)) : 0;
        row.innerHTML =
            '<div class="rmain">' +
              '<div class="rname" title="' + escAttr(t.filename) + '">' + esc(t.filename || "Unknown") + '</div>' +
              '<div class="rmeta"><span>💾 ' + formatSize(t.bytes) + '</span><span>🕘 ' + esc(new Date(t.added).toLocaleString("ko-KR")) + '</span>' +
                (t.status === "downloading" ? '<span>⏱ ' + pct + '%</span>' : "") + '</div>' +
              (t.status === "downloading" ? '<div class="rprog"><i style="width:' + pct + '%"></i></div>' : "") +
            '</div>' +
            '<span class="badge ' + getStatusClass(t.status) + '">' + esc(getStatusText(t.status)) + '</span>' +
            '<div class="racts">' +
              (t.status === "waiting_files_selection" ? '<button class="menu" data-select="' + escAttr(t.id) + '">파일 선택</button>' : "") +
              '<select class="menu" data-move="' + escAttr(t.id) + '" title="폴더로 이동">' +
                '<option value="">폴더 이동…</option>' +
                folderState.folders.map(function (fo) { return '<option value="' + escAttr(fo.id) + '"' + (folderState.map[t.id] === fo.id ? " selected" : "") + '>' + esc(fo.name) + '</option>'; }).join("") +
                (folderState.map[t.id] ? '<option value="__out">목록으로</option>' : "") +
              '</select>' +
            '</div>';
        rowsEl.appendChild(row);
    });

    rowsEl.querySelectorAll("[data-row]").forEach(function (row) {
        row.addEventListener("click", function (e) {
            if (e.target.closest("select") || e.target.closest("[data-select]")) return;
            const id = row.dataset.row;
            pickedId = (pickedId === id) ? null : id;
            rowsEl.querySelectorAll(".row").forEach(function (r) { r.classList.toggle("picked", r.dataset.row === pickedId); });
            syncToolState();
            if (pickedId) {
                const t = torrents.find(function (x) { return x.id === pickedId; });
                if (t) log("파일 선택: " + String(t.filename || "").slice(0, 40));
            }
        });
    });
    rowsEl.querySelectorAll("[data-select]").forEach(function (b) {
        b.addEventListener("click", function (e) { e.stopPropagation(); selectFiles(b.dataset.select); });
    });
    rowsEl.querySelectorAll("[data-move]").forEach(function (sel) {
        sel.addEventListener("change", function () {
            const id = sel.dataset.move, v = sel.value;
            if (!v) return;
            if (v === "__out") { delete folderState.map[id]; log("'목록'으로 이동"); }
            else { folderState.map[id] = v; const fo = folderById(v); log("'" + (fo ? fo.name : v) + "' 폴더로 이동"); }
            saveFolderState();
            pickedId = null;
            renderAll();
        });
    });
    syncToolState();
}

const NEEDS_PICK = ["pot", "stream", "rd", "down", "copy"];
function syncToolState() {
    document.querySelectorAll(".hbtn").forEach(function (b) {
        b.classList.toggle("disabled", NEEDS_PICK.indexOf(b.dataset.act) >= 0 && !pickedId);
    });
    const sel = document.getElementById("listSel");
    if (sel) {
        const t = pickedId ? torrents.find(function (x) { return x.id === pickedId; }) : null;
        sel.textContent = t ? "· " + String(t.filename || "").slice(0, 18) + "…" : "";
    }
}
function renderAll() { renderFolders(); renderList(); }

/* ---------------- 목록 로드 ---------------- */
async function refreshTorrents() {
    try {
        log("토렌트 목록을 불러오는 중...");
        const list = await makeApiCall("/torrents?limit=1000");
        torrents = Array.isArray(list) ? list : [];
        const totalBytes = torrents.reduce(function (s, t) { return s + (t.bytes || 0); }, 0);
        const sizeEl = document.getElementById("apiListSize");
        if (sizeEl) sizeEl.textContent = "📚 " + formatSize(totalBytes) + " · " + torrents.length + "개";
        renderAll();
    } catch (e) {
        const rowsEl = document.getElementById("rows");
        if (rowsEl) rowsEl.innerHTML = '<div class="empty"><b>목록을 불러오지 못했습니다</b>' + esc(e.message) + '</div>';
        toast("토렌트 목록 로드 실패: " + e.message);
    }
}

/* ---------------- 추가/선택/삭제 ---------------- */
function trackerLines() {
    return (document.getElementById("trackerInput").value || "").split("\n").map(function (s) { return s.trim(); }).filter(Boolean);
}
function withTrackers(magnet) {
    const trs = trackerLines();
    if (!trs.length) return magnet;
    return magnet + trs.map(function (tr) { return "&tr=" + encodeURIComponent(tr); }).join("");
}

async function waitForAndSelectFiles(torrentId) {
    const maxRetries = 15;
    for (let i = 0; i < maxRetries; i++) {
        const info = await makeApiCall("/torrents/info/" + torrentId);
        if (info && info.status === "waiting_files_selection") {
            await makeApiCall("/torrents/selectFiles/" + torrentId, { method: "POST", headers: { "Content-Type": "application/x-form-urlencoded" }, body: "files=all" });
            log("ID " + torrentId + " 파일 선택 완료. 다운로드가 시작됩니다.", "success");
            return;
        }
        if (info && ["downloading", "downloaded", "queued", "error", "dead"].indexOf(info.status) >= 0) {
            log("ID " + torrentId + " 는 이미 " + getStatusText(info.status) + " 상태입니다.");
            return;
        }
        await new Promise(function (r) { setTimeout(r, 2000); });
    }
    log("ID " + torrentId + " 파일 선택 단계에 진입하지 못했습니다.", "warning");
}

async function addMagnet(magnet) {
    const res = await makeApiCall("/torrents/addMagnet", { method: "POST", headers: { "Content-Type": "application/x-form-urlencoded" }, body: "magnet=" + encodeURIComponent(withTrackers(magnet)) });
    if (!res || !res.id) throw new Error("API 응답에서 토렌트 ID를 받지 못했습니다.");
    log("ID " + res.id + " 추가 성공.", "success");
    await waitForAndSelectFiles(res.id);
    return res.id;
}

async function selectFiles(id) {
    try {
        await makeApiCall("/torrents/selectFiles/" + id, { method: "POST", headers: { "Content-Type": "application/x-form-urlencoded" }, body: "files=all" });
        toast("모든 파일이 선택되어 다운로드가 시작됩니다.");
        log("ID " + id + " 파일 전체 선택", "success");
        refreshTorrents();
    } catch (e) { toast("파일 선택 실패: " + e.message); }
}

async function deleteTorrent(id) {
    if (!confirm("이 토렌트를 Real-Debrid 계정에서 영구적으로 삭제하시겠습니까?")) return;
    try {
        await makeApiCall("/torrents/delete/" + id, { method: "DELETE" });
        delete folderState.map[id]; saveFolderState();
        toast("토렌트가 RD 계정에서 삭제되었습니다");
        log("ID " + id + " 삭제", "success");
        refreshTorrents();
    } catch (e) { toast("삭제 실패: " + e.message); }
}

async function deleteCompleted() {
    if (!confirm("완료된 모든 토렌트를 Real-Debrid 계정에서 영구적으로 삭제하시겠습니까?")) return;
    try {
        const list = await makeApiCall("/torrents?limit=1000");
        const done = (list || []).filter(function (t) { return t.status === "downloaded"; });
        if (!done.length) { toast("삭제할 완료 항목이 없습니다."); return; }
        let n = 0;
        for (const t of done) { await makeApiCall("/torrents/delete/" + t.id, { method: "DELETE" }); delete folderState.map[t.id]; n++; }
        saveFolderState();
        toast(n + "개 완료 항목을 삭제했습니다.");
        log(n + "개 완료 항목 삭제", "success");
        refreshTorrents();
    } catch (e) { toast("완료 항목 삭제 실패: " + e.message); }
}

/* ---------------- 링크 해제/열기 ---------------- */
function linkForFile(info, file) {
    if (!info || !file) return "";
    const files = info.files || [];
    const links = info.links || [];
    const idx = Number(file.id) - 1;
    if (Number.isInteger(idx) && idx >= 0 && files[idx] === file && typeof links[idx] === "string" && links[idx]) return links[idx];
    const i = files.indexOf(file);
    if (i >= 0 && links.length === files.length && files.every(function (f, k) { return Number(f.id) === k + 1; }) && typeof links[i] === "string" && links[i]) return links[i];
    const selected = files.filter(function (f) { return f.selected === 1; });
    const valid = links.filter(function (l) { return typeof l === "string" && l; });
    if (selected.length > 0 && selected.length === valid.length) {
        const pos = selected.indexOf(file);
        if (pos >= 0) return valid[pos];
    }
    return "";
}
function unrestrict(link) {
    return makeApiCall("/unrestrict/link", { method: "POST", headers: { "Content-Type": "application/x-form-urlencoded" }, body: "link=" + encodeURIComponent(link) });
}
function pickVideoFile(info) {
    const exts = [".mp4", ".mkv", ".avi", ".mov", ".wmv", ".flv"];
    const files = (info && info.files) || [];
    const video = files.find(function (f) { return exts.some(function (e) { return String(f.path || "").toLowerCase().endsWith(e); }) && f.selected === 1; });
    return video || null;
}

async function openStream(torrent) {
    try {
        const info = await makeApiCall("/torrents/info/" + torrent.id);
        const vf = pickVideoFile(info);
        if (!vf) throw new Error("재생 가능한 비디오 파일을 찾지 못했습니다.");
        const link = linkForFile(info, vf);
        if (!link) throw new Error("파일 링크를 찾지 못했습니다.");
        const r = await unrestrict(link);
        if (!r || !r.download) throw new Error("직링크를 생성하지 못했습니다.");
        log("'" + vf.path + "' → 재생 링크 열기", "success");
        window.open(r.download, "_blank");
    } catch (e) { toast("재생 실패: " + e.message); }
}
async function playPotplayer(torrent) {
    try {
        const info = await makeApiCall("/torrents/info/" + torrent.id);
        const vf = pickVideoFile(info);
        if (!vf) throw new Error("재생 가능한 비디오 파일을 찾지 못했습니다.");
        const link = linkForFile(info, vf);
        const r = await unrestrict(link);
        if (!r || !r.download) throw new Error("직링크를 생성하지 못했습니다.");
        log("'" + vf.path + "' → 팟플레이어 실행", "success");
        window.location.href = "potplayer://" + r.download;
    } catch (e) { toast("팟플레이어 실행 실패: " + e.message); }
}
async function openRdPage(torrent) {
    try {
        const info = await makeApiCall("/torrents/info/" + torrent.id);
        const links = ((info && info.links) || []).filter(Boolean);
        if (!links.length) throw new Error("유효한 파일 링크가 없습니다.");
        window.open("https://real-debrid.com/downloader?links=" + encodeURIComponent(links.join("\n")), "_blank");
        log("RD 다운로더 페이지 열기", "success");
    } catch (e) { toast("RD 페이지 열기 실패: " + e.message); }
}
async function copyLink(torrent) {
    try {
        const info = await makeApiCall("/torrents/info/" + torrent.id);
        const files = ((info && info.files) || []).filter(function (f) { return f.selected === 1; });
        if (files.length > 1) { return openRdPage(torrent); }
        const f = files[0];
        const link = linkForFile(info, f);
        if (!link) throw new Error("파일 링크를 찾지 못했습니다.");
        const r = await unrestrict(link);
        if (!r || !r.download) throw new Error("다운로드 링크를 만들지 못했습니다.");
        await navigator.clipboard.writeText(r.download);
        toast("링크가 클립보드에 복사되었습니다.");
        log("링크 복사 완료", "success");
    } catch (e) { toast("링크 복사 실패: " + e.message); }
}
async function showDownloadModal(torrent) {
    try {
        toast("다운로드 링크를 생성 중입니다...");
        const info = await makeApiCall("/torrents/info/" + torrent.id);
        const files = ((info && info.files) || []).filter(function (f) { return Number(f.bytes) >= MIN_FILE_SIZE_BYTES; });
        if (!files.length) throw new Error(MIN_FILE_SIZE_BYTES / 1048576 + "MB 이상 파일이 없습니다.");
        const results = await mapLimit(files, UNRESTRICT_CONCURRENCY, function (f) {
            const link = linkForFile(info, f);
            if (!link) return Promise.resolve({ file: f, error: true });
            return unrestrict(link).then(function (r) { return { file: f, download: r && r.download, streamingLink: r && r.streamingLink }; })
                .catch(function () { return { file: f, error: true }; });
        });
        const ok = results.filter(function (r) { return r && r.download; });
        if (!ok.length) throw new Error("링크를 생성하지 못했습니다.");
        openLinksModal(info.filename || torrent.filename, ok);
        log("다운로드 링크 " + ok.length + "/" + files.length + " 생성", "success");
    } catch (e) {
        toast("링크 생성 실패: " + e.message);
        openRdPage(torrent);
    }
}
function openLinksModal(title, rows) {
    const host = document.getElementById("modalHost");
    host.innerHTML = "";
    const wrap = document.createElement("div");
    wrap.className = "modal";
    wrap.addEventListener("click", function (e) { if (e.target === wrap) wrap.remove(); });
    wrap.innerHTML =
        '<div class="box"><div class="mh"><h3>' + esc(title) + '</h3>' +
        '<button class="btn" data-close="1">닫기</button></div><div class="mb">' +
        rows.map(function (r) {
            const dl = safeUrl(r.download), st = safeUrl(r.streamingLink);
            return '<div class="fli"><span class="p">' + esc(r.file.path) + '</span><span class="sz">' + formatSize(r.file.bytes) + '</span>' +
                (st ? '<a href="' + escAttr(st) + '" target="_blank" rel="noopener">스트리밍</a>' : "") +
                (dl ? '<a href="' + escAttr(dl) + '" target="_blank" rel="noopener">다운로드</a><button data-copy="' + escAttr(dl) + '">복사</button>' : "") +
                '</div>';
        }).join("") + '</div></div>';
    host.appendChild(wrap);
    wrap.querySelectorAll("[data-close]").forEach(function (b) { b.addEventListener("click", function () { wrap.remove(); }); });
    wrap.querySelectorAll("[data-copy]").forEach(function (b) {
        b.addEventListener("click", function () { navigator.clipboard.writeText(b.dataset.copy).then(function () { toast("링크가 복사되었습니다."); }); });
    });
}

/* ---------------- 업로드 ---------------- */
let pickedFiles = [];
function bindUpload() {
    const fileInput = document.getElementById("torrentFile");
    const btn = document.getElementById("convertUploadButton");
    const magnet = document.getElementById("magnetInput");

    fileInput.addEventListener("change", function () {
        pickedFiles = Array.prototype.slice.call(fileInput.files).filter(function (f) { return f.name.toLowerCase().endsWith(".torrent"); });
        renderUploadNote();
    });
    function renderUploadNote() {
        const note = document.getElementById("upNote");
        if (pickedFiles.length) {
            note.innerHTML = '<b>' + esc(pickedFiles.length === 1 ? pickedFiles[0].name : pickedFiles.length + "개 파일") + '</b> 선택됨 ' +
                '<span id="clearPick" style="margin-left:auto;cursor:pointer">✕</span>';
            document.getElementById("clearPick").addEventListener("click", function () {
                pickedFiles = []; fileInput.value = ""; renderUploadNote();
            });
        } else {
            note.textContent = "트래커 결합 → RD 전달 (동일 처리)";
        }
    }
    window.__renderUploadNote = renderUploadNote;

    btn.addEventListener("click", async function () {
        const mags = (magnet.value || "").split("\n").map(function (s) { return s.trim(); }).filter(function (s) { return s.indexOf("magnet:?") === 0; });
        if (!mags.length && !pickedFiles.length) { fileInput.click(); return; }
        btn.disabled = true;
        const original = btn.innerHTML;
        btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
        try {
            if (mags.length) {
                log("마그넷 " + mags.length + "개 처리 시작");
                for (let i = 0; i < mags.length; i++) {
                    log("[" + (i + 1) + "/" + mags.length + "] 마그넷 추가 시도");
                    await addMagnet(mags[i]);
                }
                toast(mags.length + "개 마그넷을 추가했습니다.");
            }
            if (pickedFiles.length) {
                log(".torrent " + pickedFiles.length + "개 → 마그넷 변환 후 추가");
                for (const file of pickedFiles) {
                    const m = await fileToMagnet(file);
                    await addMagnet(m);
                }
                toast(pickedFiles.length + "개 파일을 추가했습니다.");
            }
            magnet.value = ""; pickedFiles = []; fileInput.value = "";
            renderUploadNote();
            startOrResetRefreshCycle();   // 주기 시작 시 즉시 1회 갱신됨
        } catch (e) {
            toast("업로드 실패: " + e.message);
            log("업로드 실패: " + e.message, "error");
        } finally {
            btn.disabled = false;
            btn.innerHTML = original;
        }
    });
}

/* ---------------- torrent → magnet (원본 info 바이트 SHA1) ---------------- */
function bencodeSkip(bytes, start) {
    const c = bytes.charAt(start);
    if (c === "i") return bytes.indexOf("e", start) + 1;
    if (c === "l" || c === "d") { let i = start + 1; while (i < bytes.length && bytes.charAt(i) !== "e") { i = bencodeSkip(bytes, i); if (i < 0) return -1; } return i + 1; }
    const colon = bytes.indexOf(":", start);
    if (colon < 0) return -1;
    const len = parseInt(bytes.slice(start, colon), 10);
    if (!isFinite(len) || len < 0) return -1;
    return colon + 1 + len;
}
function rawInfoBytes(bytes) {
    if (bytes.charAt(0) !== "d") return null;
    let i = 1, slice = null;
    while (i < bytes.length && bytes.charAt(i) !== "e") {
        const keyEnd = bencodeSkip(bytes, i);
        if (keyEnd < 0) return null;
        const colon = bytes.indexOf(":", i);
        if (colon < 0 || colon > keyEnd) return null;
        const key = bytes.slice(colon + 1, keyEnd);
        const valEnd = bencodeSkip(bytes, keyEnd);
        if (valEnd < 0) return null;
        if (key === "info") slice = bytes.slice(keyEnd, valEnd);
        i = valEnd;
    }
    return slice;
}
function sha1Binary(str) { const h = new SHA1(); h.update(str); const d = h.digest(); let out = ""; for (let i = 0; i < d.length; i++) out += String.fromCharCode(d[i]); return out; }
function binToText(bin) {
    try {
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i) & 0xff;
        return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    } catch (e) { return bin; }
}
function fileToMagnet(file) {
    return new Promise(function (resolve, reject) {
        const reader = new FileReader();
        reader.onload = function (e) {
            try {
                const bin = e.target.result;
                const decoded = Bencode.decode(bin);
                if (!decoded.info) throw new Error("토렌트 파일에 'info' 메타데이터가 없습니다.");
                const raw = rawInfoBytes(bin);
                const binaryHash = raw ? sha1Binary(raw) : sha1Binary(Bencode.encode(decoded.info));
                if (decoded.info["meta version"] === 2 && !decoded.info.pieces) log("v2 전용 토렌트입니다. RD에서 인식되지 않을 수 있습니다.", "warning");
                const b32 = Base32.encode(binaryHash).replace(/=/g, "").toLowerCase();
                resolve("magnet:?xt=urn:btih:" + b32 + "&dn=" + encodeURIComponent(binToText(decoded.info.name || "")));
            } catch (err) { reject(err instanceof Error ? err : new Error(String(err))); }
        };
        reader.onerror = function () { reject(new Error("파일을 읽는 중 오류가 발생했습니다.")); };
        reader.readAsBinaryString(file);
    });
}

/* ---------------- 트래커 ---------------- */
const CURATED_TRACKERS = [
    "udp://tracker.opentrackr.org:1337/announce", "udp://open.stealth.si:80/announce",
    "udp://exodus.desync.com:6969/announce", "udp://tracker.torrent.eu.org:451/announce",
    "udp://tracker.cyberia.is:6969/announce", "udp://open.demonii.com:1337/announce",
    "udp://explodie.org:6969/announce", "udp://tracker.dler.org:6969/announce"
];
async function fetchBestTrackers() {
    const input = document.getElementById("trackerInput");
    const iconEl = document.getElementById("trackerStatusIcon");
    const metaEl = document.getElementById("trackerMeta");
    const stateEl = document.getElementById("tcState");
    log("최신 통합 트래커 목록을 불러옵니다...");
    try {
        const urls = [
            "https://raw.githubusercontent.com/ngosang/trackerslist/master/trackers_best.txt",
            "https://raw.githubusercontent.com/ngosang/trackerslist/master/trackers_all_ip.txt"
        ];
        const responses = await Promise.all(urls.map(function (u) { return fetch(u); }));
        responses.forEach(function (r) { if (!r.ok) throw new Error("서버 응답 오류: " + r.status); });
        const texts = await Promise.all(responses.map(function (r) { return r.text(); }));
        const all = CURATED_TRACKERS.concat(texts.join("\n").split("\n"));
        const unique = [...new Set(all.map(function (l) { return l.trim(); }).filter(Boolean))];
        if (!unique.length) throw new Error("불러온 트래커가 없습니다.");
        input.value = unique.join("\n");
        if (iconEl) iconEl.innerHTML = '<i class="fas fa-check-circle text-green-500"></i>';
        if (metaEl) metaEl.textContent = unique.length + "개 · " + new Date().toLocaleString("ko-KR", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
        if (stateEl) stateEl.textContent = unique.length + "개";
        toast("통합된 고유 트래커 " + unique.length + "개를 불러왔습니다.");
        log("트래커 " + unique.length + "개 로드", "success");
    } catch (e) {
        if (input && !input.value) input.value = CURATED_TRACKERS.join("\n");
        if (iconEl) iconEl.innerHTML = '<i class="fas fa-times-circle text-red-500"></i>';
        if (metaEl) metaEl.textContent = "업데이트 실패";
        log("트래커 로딩 실패: " + e.message, "error");
    }
}

/* ---------------- 폴더 컨텍스트 메뉴 ---------------- */
let ctxTarget = null;
function openCtx(x, y, fid) {
    ctxTarget = fid;
    const m = document.getElementById("ctx");
    m.style.display = "block";
    m.style.left = Math.min(x, window.innerWidth - 150) + "px";
    m.style.top = Math.min(y, window.innerHeight - 90) + "px";
}
function bindCtx() {
    const m = document.getElementById("ctx");
    document.addEventListener("click", function () { m.style.display = "none"; });
    m.addEventListener("click", function (e) {
        const act = e.target.dataset.act;
        if (!act || !ctxTarget) return;
        const f = folderById(ctxTarget);
        if (!f) return;
        if (act === "rename") {
            const card = Array.prototype.slice.call(document.querySelectorAll(".folder")).find(function (c) { return c.dataset.id === f.id; });
            const nm = card.querySelector(".nm");
            nm.innerHTML = '<input value="' + escAttr(f.name) + '" />';
            const inp = nm.querySelector("input");
            inp.focus(); inp.select();
            const done = function (ok) {
                if (ok && inp.value.trim()) { f.name = inp.value.trim(); saveFolderState(); log("폴더 이름 변경 → '" + f.name + "'"); }
                renderAll();
            };
            inp.addEventListener("keydown", function (ev) { if (ev.key === "Enter") done(true); if (ev.key === "Escape") done(false); });
            inp.addEventListener("blur", function () { done(true); });
        }
        if (act === "delete") {
            if (!confirm("'" + f.name + "' 폴더를 삭제할까요? 담긴 항목은 목록으로 돌아갑니다.")) return;
            const n = countOf(f.id);
            folderState.folders = folderState.folders.filter(function (x) { return x.id !== f.id; });
            Object.keys(folderState.map).forEach(function (k) { if (folderState.map[k] === f.id) delete folderState.map[k]; });
            if (selectedFolder === f.id) selectedFolder = "all";
            pickedId = null;
            saveFolderState(); renderAll();
            log("폴더 '" + f.name + "' 삭제 · " + n + "개 항목 목록 복귀", "error");
        }
    });
}

/* ---------------- 헤더 액션 ---------------- */
async function runToolAction(act) {
    if (act === "refresh") { refreshTorrents(); return; }
    if (act === "clean") { deleteCompleted(); return; }
    if (!pickedId) { toast("파일을 먼저 선택해 주세요"); log("선택된 파일이 없습니다", "error"); return; }
    const t = torrents.find(function (x) { return x.id === pickedId; });
    if (!t) { toast("선택한 항목을 찾을 수 없습니다"); return; }
    switch (act) {
        case "pot": if (isMobileDevice()) await openStream(t); else await playPotplayer(t); break;
        case "stream": await openStream(t); break;
        case "rd": await openRdPage(t); break;
        case "down": await showDownloadModal(t); break;
        case "copy": await copyLink(t); break;
    }
}

/* ---------------- 접기(좁은 화면) ---------------- */
const COLLAPSIBLES = ["upCard", "tcCard", "logCard"];
function setCollapsed(id, on) {
    const card = document.getElementById(id);
    if (!card) return;
    card.classList.toggle("collapsed", on);
    const label = card.querySelector(".c-head .c-right span");
    if (label) label.textContent = on ? "펼치기" : "접기";
}
function applyNarrowDefaults() {
    COLLAPSIBLES.forEach(function (id) { setCollapsed(id, NARROW.matches); });
    const api = document.getElementById("apiCard");
    if (api) api.classList.remove("open");   // API 설정은 항상 접힌 상태로 시작
}
function bindCollapse() {
    document.querySelectorAll(".c-head").forEach(function (h) {
        h.addEventListener("click", function () {
            const id = h.dataset.toggle;
            setCollapsed(id, !document.getElementById(id).classList.contains("collapsed"));
        });
    });
    NARROW.addEventListener("change", applyNarrowDefaults);
}

/* ---------------- 폴더 가로 드래그 ---------------- */
function bindFolderDrag() {
    let down = false, sx = 0, sl = 0, box = null, moved = false;
    document.addEventListener("pointerdown", function (e) {
        const b = e.target.closest(".folders");
        if (!b) return;
        box = b; down = true; moved = false; sx = e.clientX; sl = b.scrollLeft; b.classList.add("dragging");
    });
    document.addEventListener("pointermove", function (e) {
        if (!down || !box) return;
        const dx = e.clientX - sx;
        if (Math.abs(dx) > 4) { moved = true; box.scrollLeft = sl - dx; }
    });
    document.addEventListener("pointerup", function () { if (box) box.classList.remove("dragging"); down = false; box = null; });
    document.addEventListener("click", function (e) { if (moved) { e.stopPropagation(); e.preventDefault(); moved = false; } }, true);
}

/* ---------------- 초기화 ---------------- */
function initializeApp() {
    /* 아이콘 */
    document.querySelectorAll(".hbtn").forEach(function (b) {
        const map = { pot: "pot", stream: "stream", rd: "rd", down: "down", copy: "copy", refresh: "refresh", clean: "clean" };
        b.innerHTML = ICONS[map[b.dataset.act]] || ICONS.copy;
        if (b.dataset.act === "pot" && isMobileDevice()) b.style.display = "none";
        if (b.dataset.act === "stream" && isMobileDevice()) b.dataset.tip = "폰에서 재생";
    });

    bindUpload();
    bindCtx();
    bindCollapse();
    bindFolderDrag();
    applyNarrowDefaults();

    document.getElementById("btnAll").addEventListener("click", function () { selectedFolder = "all"; pickedId = null; renderAll(); });
    document.getElementById("btnAddFolder").addEventListener("click", addFolder);
    document.getElementById("listTools").addEventListener("click", function (e) {
        const b = e.target.closest(".hbtn");
        if (b) runToolAction(b.dataset.act);
    });

    document.getElementById("apiHead").addEventListener("click", function () { document.getElementById("apiCard").classList.toggle("open"); });
    document.getElementById("btnSaveToken").addEventListener("click", function (e) { e.stopPropagation(); saveToken(); });
    document.getElementById("btnTestConn").addEventListener("click", function (e) { e.stopPropagation(); testConnection(); });
    document.getElementById("btnFetchTrackers").addEventListener("click", function (e) { e.stopPropagation(); fetchBestTrackers(); });

    const saved = getToken() || "";
    if (saved) {
        testConnection();
    } else {
        document.getElementById("apiStatus").textContent = "토큰 없음";
        log("API 토큰이 설정되지 않았습니다. 토큰을 입력하고 저장해주세요.", "warning");
    }
    fetchBestTrackers();
    renderAll();
    log("페이지가 로드되었습니다.");
}

document.addEventListener("DOMContentLoaded", initializeApp);
