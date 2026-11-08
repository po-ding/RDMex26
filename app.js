// ============== 전역 변수 및 상수 ==============
const API_BASE = "https://api.real-debrid.com/rest/1.0";
let refreshTimer = null;
let fastRefreshCount = 0;
let slowRefreshCount = 0;

// ============== 보조 함수 (상단에 정의) ==============
function addLog(message, type = "info") { const logEl = document.getElementById("statusLog"); const time = new Date().toLocaleTimeString(); const iconClass = type === "error" ? "fa-times-circle text-red-500" : type === "success" ? "fa-check-circle text-green-500" : type === "warning" ? "fa-exclamation-triangle text-yellow-500" : "fa-info-circle text-blue-500"; const initialMsg = document.getElementById("initialLogMessage"); if (initialMsg) initialMsg.remove(); const entry = document.createElement("div"); entry.className = `mb-2 p-2 border-l-4 ${type === "error" ? "border-red-400 bg-red-50" : type === "success" ? "border-green-400 bg-green-50" : type === "warning" ? "border-yellow-400 bg-yellow-50" : "border-blue-400 bg-blue-50"}`; entry.innerHTML = `<span class="text-xs text-gray-500">[${time}]</span> <i class="fas ${iconClass} ml-2 mr-2"></i> <span>${message}</span>`; logEl.appendChild(entry); logEl.scrollTop = logEl.scrollHeight; }
function showToast(message, type = "info") { const container = document.getElementById("toastContainer"); const toast = document.createElement("div"); const iconClass = type === "success" ? "fa-check-circle" : type === "error" ? "fa-exclamation-circle" : type === "warning" ? "fa-exclamation-triangle" : "fa-info-circle"; const bgColor = type === "success" ? "bg-green-500" : type === "error" ? "bg-red-600" : type === "warning" ? "bg-yellow-500" : "bg-blue-500"; toast.className = `fade-in px-6 py-4 rounded-lg text-white mb-4 shadow-lg ${bgColor}`; toast.innerHTML = `<div class="flex items-center"><i class="fas ${iconClass} mr-3"></i><span class="font-semibold">${message}</span></div>`; container.appendChild(toast); setTimeout(() => { toast.style.opacity = "0"; setTimeout(() => toast.remove(), 300); }, 5000); }
function setLoading(button, isLoading) { if (!button) return; const originalText = button.dataset.originalText || button.innerHTML; if (isLoading) { button.dataset.originalText = originalText; button.disabled = true; button.classList.add("opacity-75", "cursor-not-allowed"); button.innerHTML = `<i class="fas fa-spinner fa-spin"></i>`; } else { if (button.dataset.originalText) { button.innerHTML = button.dataset.originalText; delete button.dataset.originalText; } button.disabled = false; button.classList.remove("opacity-75", "cursor-not-allowed"); } }
function getStatusClass(status) { return { waiting_files_selection: "bg-yellow-100 text-yellow-800", queued: "bg-gray-200 text-gray-800", downloading: "bg-blue-100 text-blue-800", downloaded: "bg-green-100 text-green-800", error: "bg-red-100 text-red-800", dead: "bg-red-200 text-red-900" }[status] || "bg-gray-100 text-gray-800"; }
function getStatusText(status) { return { waiting_files_selection: "파일 선택 대기", queued: "대기 중", downloading: "다운로드 중", downloaded: "완료", error: "오류", dead: "데드 토렌트" }[status] || status; }
function formatSize(bytes) { if (bytes === 0) return "0 B"; const k = 1024; const sizes = ["B", "KB", "MB", "GB", "TB"]; const i = Math.floor(Math.log(bytes) / Math.log(k)); return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i]; }
function isMobile() { const hasTouchEvent = 'ontouchstart' in window || navigator.maxTouchPoints > 0; const isMobileUA = /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent); return hasTouchEvent && isMobileUA; }

function displayFileName(file) {
    const dropZoneContent = document.getElementById("dropZoneContent");
    if (file) {
        dropZoneContent.innerHTML = `<div class="text-center"><i class="fas fa-check-circle text-green-500 mr-2"></i> <strong>${file.name}</strong> (${formatSize(file.size)})</div>`;
    } else {
        dropZoneContent.innerHTML = `<i class="fas fa-cloud-upload-alt text-4xl text-gray-400"></i><p class="mt-2 text-sm text-gray-600">.torrent 파일을 드롭하거나 클릭하여 추가</p>`;
    }
}

// ★★★ [신규/수정됨] 파일이 선택될 때 UI를 업데이트하는 함수
function handleFileSelectionChange() {
    const fileInput = document.getElementById('torrentFile');
    const directUploadButton = document.getElementById('directUploadButton');
    const file = fileInput.files.length > 0 ? fileInput.files[0] : null;

    displayFileName(file);

    if (file) {
        directUploadButton.disabled = false;
        directUploadButton.classList.remove('opacity-50', 'cursor-not-allowed');
    } else {
        directUploadButton.disabled = true;
        directUploadButton.classList.add('opacity-50', 'cursor-not-allowed');
    }
}

function fileToMagnet(file) { return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = function(e) { try { const torrentDataString = e.target.result; const decoded = Bencode.decode(torrentDataString); if (!decoded.info) throw new Error("토렌트 파일에 'info' 메타데이터가 없습니다."); const infoBencoded = Bencode.encode(decoded.info); const sha1 = new SHA1(); sha1.update(infoBencoded); const infoHash = sha1.digest(); let binaryHashString = ''; for (let i = 0; i < infoHash.length; i++) { binaryHashString += String.fromCharCode(infoHash[i]); } const infoHashBase32 = Base32.encode(binaryHashString).replace(/=/g, '').toLowerCase(); const magnetURI = `magnet:?xt=urn:btih:${infoHashBase32}&dn=${encodeURIComponent(decoded.info.name || '')}`; resolve(magnetURI); } catch (error) { const errorMessage = (error instanceof Error) ? error.message : error; reject(new Error(errorMessage)); } }; reader.onerror = () => reject(new Error("파일을 읽는 중 오류가 발생했습니다.")); reader.readAsBinaryString(file); }); }

// ============== ★★★ 새로운 업로드 핸들러 함수들 ★★★ ==============

// [핸들러 1] "마그넷 / 변환 업로드" 버튼 클릭 시
async function handleConvertUpload(button) {
    const magnetInput = document.getElementById("magnetInput");
    const fileInput = document.getElementById('torrentFile');
    
    setLoading(button, true);

    try {
        if (fileInput.files.length > 0) {
            // .torrent 파일이 있으면 -> 변환해서 업로드
            addLog(`토렌트 파일(${fileInput.files[0].name})을 마그넷으로 변환하여 처리를 시작합니다...`);
            await convertAndUploadAsMagnet(fileInput.files[0]);
            showToast(`'${fileInput.files[0].name}' 파일이 RD에 성공적으로 추가되었습니다.`, "success");
            fileInput.value = ''; // 성공 후 파일 입력 초기화
            handleFileSelectionChange();
        } else if (magnetInput.value.trim().split('\n').map(l => l.trim()).filter(l => l.startsWith('magnet:?')).length > 0) {
            // 마그넷 링크가 있으면 -> 그대로 업로드
            await uploadMagnetLinks(magnetInput.value);
            magnetInput.value = ''; // 성공 후 마그넷 입력 초기화
            magnetInput.dispatchEvent(new Event('blur'));
        } else {
            showToast("추가할 마그넷 링크 또는 .torrent 파일이 없습니다.", "warning");
        }
    } catch (error) {
        const errorMessage = `처리 실패: ${error.message}`;
        showToast(errorMessage, "error");
        addLog(errorMessage, "error");
    } finally {
        setLoading(button, false);
    }
}

// [핸들러 2] "파일 직접 업로드" 버튼 클릭 시
async function handleDirectUpload(button) {
    const fileInput = document.getElementById('torrentFile');
    if (fileInput.files.length === 0) {
        showToast(".torrent 파일을 먼저 선택해주세요.", "warning");
        return;
    }
    const file = fileInput.files[0];

    setLoading(button, true);
    addLog(`토렌트 파일(${file.name})을 직접 전송하여 처리를 시작합니다...`);
    
    try {
        await uploadTorrentFileDirectly(file);
        showToast(`'${file.name}' 파일이 RD에 성공적으로 추가되었습니다.`, "success");
        fileInput.value = ''; // 성공 후 파일 입력 초기화
        handleFileSelectionChange();
    } catch (error) {
        const errorMessage = `파일 직접 전송 실패: ${error.message}`;
        showToast(errorMessage, "error");
        addLog(errorMessage, "error");
    } finally {
        setLoading(button, false);
    }
}

// ============== ★★★ 핵심 로직 함수들 (재구성됨) ★★★ ==============

// [로직 1] 파일 -> 마그넷 변환 및 업로드
async function convertAndUploadAsMagnet(file) {
    const trackerInput = document.getElementById("trackerInput");
    addLog("1단계: 마그넷 링크로 변환 중...");
    const magnetURI = await fileToMagnet(file);
    addLog("1단계: 변환 성공.", "success");
    addLog("2단계: 트래커 정보 결합 중...");
    const trackers = trackerInput.value.trim().split("\n").filter(Boolean);
    const trackerString = trackers.map(tr => `&tr=${encodeURIComponent(tr.trim())}`).join("");
    const finalMagnet = magnetURI + trackerString;
    addLog(`2단계: ${trackers.length}개의 트래커 결합 완료.`, "success");
    addLog("3단계: Real-Debrid에 추가 요청...");
    const response = await makeApiCall("/torrents/addMagnet", { method: "POST", headers: { "Content-Type": "application/x-form-urlencoded" }, body: `magnet=${encodeURIComponent(finalMagnet)}` });
    if (!response || !response.id) throw new Error("API 응답에서 토렌트 ID를 받지 못했습니다.");
    const torrentId = response.id;
    addLog(`3단계: ID ${torrentId} 추가 성공. 파일 선택을 기다립니다...`, "success");
    await waitForAndSelectFiles(torrentId);
    setTimeout(() => startOrResetRefreshCycle(), 1500);
}

// [로직 2] 마그넷 링크(들) 업로드
async function uploadMagnetLinks(magnetData) {
    const trackerInput = document.getElementById("trackerInput");
    const magnets = magnetData.trim().split('\n').map(line => line.trim()).filter(line => line.startsWith('magnet:?'));
    let successCount = 0, errorCount = 0;
    addLog(`총 ${magnets.length}개의 마그넷 처리를 시작합니다.`);
    const trackers = trackerInput.value.trim().split("\n").filter(Boolean);
    const trackerString = trackers.map(tr => `&tr=${encodeURIComponent(tr.trim())}`).join("");
    if (trackerString) addLog(`${trackers.length}개의 트래커를 각 마그넷에 추가합니다.`);
    for (const [index, magnet] of magnets.entries()) {
        addLog(`[${index + 1}/${magnets.length}] 마그넷 추가 시도 중...`);
        try {
            const finalMagnet = magnet + trackerString;
            const response = await makeApiCall("/torrents/addMagnet", { method: "POST", headers: { "Content-Type": "application/x-form-urlencoded" }, body: `magnet=${encodeURIComponent(finalMagnet)}` });
            if (response && response.id) {
                addLog(`[${index + 1}/${magnets.length}] ID ${response.id} 추가 성공. 파일 목록을 기다립니다...`);
                await waitForAndSelectFiles(response.id);
                successCount++;
            } else { throw new Error("API 응답에서 토렌트 ID를 받지 못했습니다."); }
        } catch (e) {
            errorCount++;
            addLog(`[${index + 1}/${magnets.length}] 처리 중 오류 발생: ${e.message}`, "error");
        }
    }
    if (successCount > 0) showToast(`총 ${successCount}개 항목의 다운로드를 성공적으로 시작했습니다.`, "success");
    if (errorCount > 0) showToast(`${errorCount}개 항목 추가에 실패했습니다. 로그를 확인하세요.`, "error");
    setTimeout(() => startOrResetRefreshCycle(), 1500);
}

// [로직 3] 파일 직접 업로드
async function uploadTorrentFileDirectly(file) {
    addLog("1단계: 파일을 Real-Debrid 서버로 직접 전송합니다.");
    const fileData = await file.arrayBuffer();
    const response = await makeApiCall("/torrents/addTorrent", { method: "PUT", body: fileData });
    if (!response || !response.id) throw new Error("API 응답에서 토렌트 ID를 받지 못했습니다.");
    const torrentId = response.id;
    addLog(`1단계: ID ${torrentId} 추가 성공. 파일 선택을 기다립니다...`, "success");
    await waitForAndSelectFiles(torrentId);
    setTimeout(() => startOrResetRefreshCycle(), 1500);
}

// [공통 로직] 파일 선택 대기 및 자동 선택
async function waitForAndSelectFiles(torrentId) { const maxRetries = 15; let readyForSelection = false; for (let i = 0; i < maxRetries; i++) { const info = await makeApiCall(`/torrents/info/${torrentId}`); if (info.status === 'waiting_files_selection') { readyForSelection = true; break; } if (['downloading', 'downloaded', 'queued', 'error', 'dead'].includes(info.status)) { addLog(`ID ${torrentId}는 이미 처리 중이거나 다른 상태(${info.status})입니다. 파일 선택을 건너뜁니다.`); return; } await new Promise(resolve => setTimeout(resolve, 2000)); } if (readyForSelection) { addLog(`ID ${torrentId} 파일 선택을 시작합니다.`); await makeApiCall(`/torrents/selectFiles/${torrentId}`, { method: "POST", headers: { "Content-Type": "application/x-form-urlencoded" }, body: "files=all" }); addLog(`ID ${torrentId} 파일 선택 완료. 다운로드가 시작됩니다.`, "success"); } else { addLog(`ID ${torrentId}의 파일 선택 단계로 진입하지 못했습니다. 수동 확인이 필요할 수 있습니다.`, "warning"); } }
function getToken() { return localStorage.getItem("rdToken"); }
function saveToken() { const token = document.getElementById("apiToken").value.trim(); if (token) { localStorage.setItem("rdToken", token); showToast("API 토큰이 저장되었습니다", "success"); testConnection(); } else { showToast("토큰을 입력해주세요", "warning"); } }
async function makeApiCall(endpoint, options = {}) { const token = getToken(); if (!token) throw new Error("API 토큰이 설정되지 않았습니다."); const url = `${API_BASE}${endpoint}`; const headers = { Authorization: `Bearer ${token}`, ...(options.headers || {}) }; const finalOptions = { ...options, headers }; try { const response = await fetch(url, finalOptions); if (response.status === 204) return null; const data = await response.json(); if (!response.ok) { const errorDetails = data && data.error ? `${data.error_code || ''} - ${data.error}` : response.statusText; throw new Error(`API 오류: ${response.status} - ${errorDetails}`); } return data; } catch (error) { addLog(`API 호출 실패: ${error.message}`, "error"); throw error; } }
function scheduledRefresh() { if (fastRefreshCount > 0) { addLog(`[자동 갱신] 1분 간격 새로고침 (${fastRefreshCount - 1}회 남음)`); refreshTorrents(); fastRefreshCount--; if (fastRefreshCount === 0) { addLog("빠른 갱신 종료. 5분 간격으로 전환."); clearInterval(refreshTimer); if (slowRefreshCount > 0) { refreshTimer = setInterval(scheduledRefresh, 300000); } } } else if (slowRefreshCount > 0) { addLog(`[자동 갱신] 5분 간격 새로고침 (${slowRefreshCount - 1}회 남음)`); refreshTorrents(); slowRefreshCount--; if (slowRefreshCount === 0) { addLog("자동 갱신 종료."); clearInterval(refreshTimer); refreshTimer = null; } } else { if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; } } }
function startOrResetRefreshCycle() { if (refreshTimer) clearInterval(refreshTimer); addLog("자동 갱신 주기 시작."); fastRefreshCount = 5; slowRefreshCount = 11; scheduledRefresh(); refreshTimer = setInterval(scheduledRefresh, 60000); }
async function fetchBestTrackers() { const trackerInput = document.getElementById("trackerInput"); const statusIcon = document.getElementById("trackerStatusIcon"); const updateTimeEl = document.getElementById("trackerUpdateTime"); const curatedTrackers = [ 'udp://tracker.opentrackr.org:1337/announce', 'udp://open.stealth.si:80/announce', 'udp://exodus.desync.com:6969/announce', 'udp://tracker.torrent.eu.org:451/announce', 'udp://tracker.cyberia.is:6969/announce', 'udp://tracker.openbittrent.com:80/announce', 'udp://tracker.zer0day.to:1337/announce', 'udp://p4p.arenabg.com:1337/announce', 'udp://tracker.leechers-paradise.org:6969/announce', 'udp://9.rarbg.to:2710/announce', 'http://open.tracker.cl:1337/announce', 'udp://open.demonii.com:1337/announce', 'udp://explodie.org:6969/announce', 'udp://public.tracker.vraphim.com:6969/announce', 'udp://tracker.dler.org:6969/announce' ]; const externalTrackerUrls = [ 'https://raw.githubusercontent.com/ngosang/trackerslist/master/trackers_best.txt', 'https://raw.githubusercontent.com/ngosang/trackerslist/master/trackers_all_ip.txt' ]; statusIcon.innerHTML = '<i class="fas fa-spinner loading text-purple-500"></i>'; addLog(`최신 통합 트래커 목록을 불러옵니다...`); try { const responses = await Promise.all(externalTrackerUrls.map(url => fetch(url))); for (const response of responses) { if (!response.ok) throw new Error(`서버 응답 오류: ${response.status} for ${response.url}`); } const externalTexts = await Promise.all(responses.map(res => res.text())); const combinedTrackers = curatedTrackers.concat(externalTexts.join('\n').split('\n')); const uniqueTrackers = [...new Set(combinedTrackers.map(l => l.trim()).filter(Boolean))]; if (uniqueTrackers.length > 0) { trackerInput.value = uniqueTrackers.join('\n'); statusIcon.innerHTML = '<i class="fas fa-check-circle text-green-500" title="최신 트래커 로딩 완료"></i>'; const message = `통합된 고유 트래커 ${uniqueTrackers.length}개를 불러왔습니다.`; showToast(message, 'success'); const now = new Date(); const formattedTime = now.toLocaleString('ko-KR', { year: '2-digit', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }); updateTimeEl.innerHTML = `${uniqueTrackers.length}개<br class="md:hidden"> ${formattedTime}`; } else { throw new Error('불러온 트래커 목록이 비어있습니다.'); } } catch (error) { statusIcon.innerHTML = '<i class="fas fa-times-circle text-red-500" title="트래커 로딩 실패"></i>'; const errorMessage = `트래커 로딩 실패: ${error.message}`; addLog(errorMessage, 'error'); showToast(errorMessage, 'error'); updateTimeEl.textContent = '업데이트 실패'; } }
async function refreshTorrents(){ try{ addLog("토렌트 목록을 불러오는 중..."); const torrents = await makeApiCall("/torrents?limit=1000"); const totalBytes = torrents.reduce((sum, torrent) => sum + torrent.bytes, 0); document.getElementById('apiListSize').innerHTML = `📚 ${formatSize(totalBytes)}`; displayTorrents(torrents); } catch(e) { showToast("토렌트 목록 로드 실패: "+e.message,"error"); document.getElementById("torrentList").innerHTML=`<p class="text-red-500 text-center py-8">${e.message}</p>`; } }
function hideTorrentFromList(buttonElement) { const torrentItem = buttonElement.closest('.torrent-item'); if (torrentItem) { torrentItem.style.display = 'none'; addLog("항목을 현재 목록에서 숨겼습니다.", "info"); showToast("목록에서 숨김 처리되었습니다.", "info"); } }
async function deleteTorrent(id, buttonElement) { if (!confirm("이 토렌트를 Real-Debrid 계정에서 영구적으로 삭제하시겠습니까? 이 작업은 되돌릴 수 없습니다.")) return; const torrentItem = buttonElement.closest('.torrent-item'); setLoading(buttonElement, true); try { await makeApiCall(`/torrents/delete/${id}`, { method: "DELETE" }); showToast("토렌트가 RD 계정에서 삭제되었습니다", "success"); addLog(`ID ${id}: RD 계정에서 영구적으로 삭제되었습니다.`, 'success'); if (torrentItem) torrentItem.remove(); } catch (e) { showToast("삭제 실패: " + e.message, "error"); addLog(`ID ${id} 삭제 실패: ${e.message}`, 'error'); setLoading(buttonElement, false); } }

function displayTorrents(torrents) { 
    const listEl = document.getElementById("torrentList"); 
    if (torrents && torrents.length > 0) { 
        listEl.innerHTML = torrents.map(t => { 
            const buttonClasses = "w-9 h-9 flex items-center justify-center text-base rounded-lg"; 
            let potplayerButtonHTML = ''; 
            if (isMobile()) { 
                potplayerButtonHTML = `<button class="${buttonClasses} btn-link" title="새 탭에서 영상 열기" onclick="openVideoStream('${t.id}', this)"><i class="fas fa-video"></i></button>`; 
            } else { 
                potplayerButtonHTML = `<button class="${buttonClasses} btn-potplayer" title="PC 팟플레이어로 재생" onclick="playInPotplayer('${t.id}', this)"><i class="fas fa-play"></i></button>`; 
            } 
            const commonActions = `<button class="${buttonClasses} btn-hide" title="목록에서 숨기기" onclick="hideTorrentFromList(this)"><i class="fas fa-eye-slash"></i></button> <button class="${buttonClasses} btn-delete" title="RD 계정에서 영구 삭제" onclick="deleteTorrent('${t.id}', this)"><i class="fas fa-trash"></i></button>`; 
            const downloadedPrefixActions = potplayerButtonHTML + `<button class="${buttonClasses} btn-stream" title="웹 브라우저로 스트리밍" onclick="streamFirstVideo('${t.id}', this)"><i class="fas fa-tv"></i></button> <button class="${buttonClasses} btn-rdpage" title="RD 페이지에서 보기" onclick="openRdDownloaderPage('${t.id}', this)"><i class="fas fa-external-link-alt"></i></button> <button class="${buttonClasses} btn-download" title="다운로드/링크 보기" onclick="getTorrentInfo('${t.id}', this)"><i class="fas fa-download"></i></button> <button class="${buttonClasses} btn-link" title="링크 복사 (파일 1개) / RD 페이지 열기 (2개 이상)" onclick="copyLinks('${t.id}', this)"><i class="fas fa-link"></i></button>`; 
            const progressBarColor = 'bg-blue-600'; 

            // ▼▼▼ 수정된 부분 ▼▼▼
            const formattedDate = new Date(t.added).toLocaleString('ko-KR', {
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
                hour12: true
            });

            return `<div class="torrent-item border-b border-gray-200 p-3 hover:bg-gray-200 transition duration-200"> 
                <div class="flex justify-between items-start mb-2"> 
                    <h3 class="font-semibold text-gray-800 flex-1 mr-4 overflow-hidden text-ellipsis whitespace-nowrap min-w-0" title="${t.filename}">${t.filename || "Unknown"}</h3> 
                    <span class="px-2 py-1 rounded text-xs font-medium whitespace-nowrap ${getStatusClass(t.status)}">${getStatusText(t.status)}</span> 
                </div> 

                <div class="flex justify-between items-center text-sm text-gray-600 mb-3">
                    <div class="flex items-center gap-x-4">
                        <span><i class="fas fa-hdd mr-1 text-gray-400"></i> ${formatSize(t.bytes)}</span>
                        <span><i class="fas fa-arrow-down mr-1 text-green-500"></i> ${formatSize(t.speed || 0)}/s</span>
                    </div>
                    <div class="text-right whitespace-nowrap">
                        <i class="fas fa-clock mr-1 text-gray-400"></i>
                        <span>${formattedDate}</span>
                    </div>
                </div>

                ${t.progress >= 0 ? `<div class="w-full bg-gray-300 rounded-full h-2.5 mb-3"><div class="${progressBarColor} h-2.5 rounded-full" style="width: ${t.progress}%"></div></div>` : ""} 
                <div class="flex justify-between items-center mt-2"> 
                    <div>${t.status === "waiting_files_selection" ? `<button onclick="selectFiles('${t.id}')" class="px-3 py-1 bg-blue-600 text-white text-xs font-semibold rounded hover:bg-blue-700"><i class="fas fa-check-square mr-1"></i>파일 선택</button>` : ""}</div> 
                    <div class="flex gap-2 flex-wrap items-center"> ${t.status === "downloaded" ? downloadedPrefixActions + commonActions : commonActions} </div> 
                </div> 
            </div>`; 
            // ▲▲▲ 수정 완료 ▲▲▲
        }).join(""); 
    } else { 
        listEl.innerHTML = '<p class="text-gray-500 text-center py-8">활성 토렌트가 없습니다.</p>'; 
    } 
}

async function streamFirstVideo(torrentId, button) { setLoading(button, true); addLog(`ID ${torrentId}: 웹 스트리밍 링크를 찾습니다...`); try { const info = await makeApiCall(`/torrents/info/${torrentId}`); const videoExtensions = ['.mp4', '.mkv', '.avi', '.mov', '.wmv']; let firstVideoLink = null; let videoFileFound = null; if (info && info.files) { const videoFile = info.files.find(file => videoExtensions.some(ext => file.path.toLowerCase().endsWith(ext)) && file.selected === 1); if (videoFile) { firstVideoLink = info.links[videoFile.id - 1]; videoFileFound = videoFile; } } if (!firstVideoLink) { throw new Error("스트리밍 가능한 비디오 파일을 찾지 못했습니다."); } addLog(`ID ${torrentId}: '${videoFileFound.path}' 파일의 링크를 변환합니다.`); const unrestrictInfo = await makeApiCall(`/unrestrict/link`, { method: 'POST', headers: { 'Content-Type': 'application/x-form-urlencoded' }, body: `link=${encodeURIComponent(firstVideoLink)}` }); if (unrestrictInfo && unrestrictInfo.id) { const streamingUrl = `https://real-debrid.com/streaming-${unrestrictInfo.id}`; addLog(`ID ${torrentId}: 스트리밍 페이지를 엽니다: ${streamingUrl}`, 'success'); window.open(streamingUrl, '_blank'); } else { throw new Error("스트리밍 링크를 생성하지 못했습니다."); } } catch (error) { const errorMessage = `웹 스트리밍 실패: ${error.message}`; showToast(errorMessage, "error"); addLog(errorMessage, 'error'); } finally { setLoading(button, false); } }
async function openVideoStream(torrentId, button) { setLoading(button, true); addLog(`ID ${torrentId}: 모바일용 영상 스트림 링크를 찾습니다...`); try { const info = await makeApiCall(`/torrents/info/${torrentId}`); const videoExtensions = ['.mp4', '.mkv', '.avi', '.mov', '.wmv']; let videoRdLink = null; let videoFileName = null; if (info && info.files) { const videoFile = info.files.find(file => videoExtensions.some(ext => file.path.toLowerCase().endsWith(ext)) && file.selected === 1); if (videoFile) { videoRdLink = info.links[videoFile.id - 1]; videoFileName = videoFile.path; } } if (!videoRdLink) { throw new Error("재생 가능한 비디오 파일을 찾지 못했습니다."); } addLog(`ID ${torrentId}: '${videoFileName}' 파일의 실제 스트리밍 주소를 생성합니다.`); const unrestrictInfo = await makeApiCall(`/unrestrict/link`, { method: 'POST', headers: { 'Content-Type': 'application/x-form-urlencoded' }, body: `link=${encodeURIComponent(videoRdLink)}` }); if (unrestrictInfo && unrestrictInfo.download) { const directLink = unrestrictInfo.download; addLog(`ID ${torrentId}: 새 탭에서 영상을 엽니다...`, 'success'); showToast("새 탭에서 영상을 엽니다.", "success"); window.open(directLink, '_blank'); } else { throw new Error("실제 스트리밍 링크를 생성하지 못했습니다."); } } catch (error) { const errorMessage = `영상 열기 실패: ${error.message}`; showToast(errorMessage, "error"); addLog(errorMessage, 'error'); } finally { setLoading(button, false); } }
async function playInPotplayer(torrentId, button) { setLoading(button, true); addLog(`ID ${torrentId}: 팟플레이어 재생용 링크를 찾습니다...`); try { const info = await makeApiCall(`/torrents/info/${torrentId}`); const videoExtensions = ['.mp4', '.mkv', '.avi', '.mov', '.wmv']; let videoRdLink = null; let videoFileName = null; if (info && info.files) { const videoFile = info.files.find(file => videoExtensions.some(ext => file.path.toLowerCase().endsWith(ext)) && file.selected === 1); if (videoFile) { videoRdLink = info.links[videoFile.id - 1]; videoFileName = videoFile.path; } } if (!videoRdLink) { throw new Error("재생 가능한 비디오 파일을 찾지 못했습니다."); } addLog(`ID ${torrentId}: '${videoFileName}' 파일의 실제 스트리밍 주소를 생성합니다.`); const unrestrictInfo = await makeApiCall(`/unrestrict/link`, { method: 'POST', headers: { 'Content-Type': 'application/x-form-urlencoded' }, body: `link=${encodeURIComponent(videoRdLink)}` }); if (unrestrictInfo && unrestrictInfo.download) { const directLink = unrestrictInfo.download; const potplayerUrl = 'potplayer://' + directLink; addLog(`ID ${torrentId}: 팟플레이어를 실행합니다...`, 'success'); showToast("팟플레이어를 실행합니다.", "success"); window.location.href = potplayerUrl; } else { throw new Error("실제 스트리밍 링크를 생성하지 못했습니다."); } } catch (error) { const errorMessage = `팟플레이어 재생 실패: ${error.message}`; showToast(errorMessage, "error"); addLog(errorMessage, 'error'); } finally { setLoading(button, false); } }
async function deleteCompleted() { if (!confirm("완료된 모든 토렌트를 Real-Debrid 계정에서 영구적으로 삭제하시겠습니까?")) return; addLog("완료된 토렌트 삭제를 시작합니다..."); try { const torrents = await makeApiCall("/torrents?limit=1000"); const completed = torrents.filter(t => t.status === 'downloaded'); if (completed.length === 0) { showToast("삭제할 완료된 토렌트가 없습니다.", "info"); addLog("삭제할 완료된 항목이 없습니다."); return; } let deletedCount = 0; for (const torrent of completed) { await makeApiCall(`/torrents/delete/${torrent.id}`, { method: "DELETE" }); deletedCount++; } showToast(`${deletedCount}개의 완료된 토렌트가 삭제되었습니다.`, "success"); addLog(`${deletedCount}개의 완료된 토렌트를 성공적으로 삭제했습니다.`, "success"); await refreshTorrents(); } catch (error) { showToast("완료된 토렌트 삭제 중 오류 발생.", "error"); addLog(`완료된 항목 삭제 실패: ${error.message}`, "error"); } }
async function selectFiles(id) { try { addLog(`ID ${id}: 모든 파일을 선택합니다.`); await makeApiCall(`/torrents/selectFiles/${id}`, { method: "POST", headers: { "Content-Type": "application/x-form-urlencoded" }, body: "files=all" }); showToast("모든 파일이 선택되어 다운로드가 시작됩니다.", "success"); await refreshTorrents(); } catch (e) { showToast("파일 선택 실패: " + e.message, "error"); } }
async function openRdDownloaderPage(torrentId, button) { setLoading(button, true); try { const info = await makeApiCall(`/torrents/info/${torrentId}`); if (info && info.links && info.links.length > 0) { const validLinks = info.links.filter(Boolean); if (validLinks.length > 0) { const linksString = validLinks.join('\n'); const encodedLinks = encodeURIComponent(linksString); const downloaderUrl = `https://real-debrid.com/downloader?links=${encodedLinks}`; window.open(downloaderUrl, '_blank'); } else { throw new Error("유효한 파일 링크가 없습니다."); } } else { throw new Error("파일 정보를 찾을 수 없습니다."); } } catch (error) { showToast(`RD 페이지 열기 실패: ${error.message}`, "error"); } finally { setLoading(button, false); } }
async function unrestrictAndGetLinks(torrentId) { addLog(`ID ${torrentId}: 파일 정보 및 비공개 링크를 조회합니다.`); const info = await makeApiCall(`/torrents/info/${torrentId}`); if (!info || !info.links || info.links.length === 0) { throw new Error("처리할 파일 링크를 찾을 수 없습니다."); } addLog(`ID ${torrentId}: ${info.links.length}개의 링크를 실제 다운로드 링크로 변환합니다...`); const unrestrictPromises = info.links.map(link => makeApiCall('/unrestrict/link', { method: 'POST', headers: { 'Content-Type': 'application/x-form-urlencoded' }, body: `link=${encodeURIComponent(link)}` })); const results = await Promise.all(unrestrictPromises); return results.filter(r => r && r.download).map(r => r.download); }
async function copyLinks(torrentId, button) { setLoading(button, true); try { const downloadableLinks = await unrestrictAndGetLinks(torrentId); if (downloadableLinks.length === 1) { const linkToCopy = downloadableLinks[0]; await navigator.clipboard.writeText(linkToCopy); const message = "1개 파일의 링크가 클립보드에 복사되었습니다."; showToast(message, 'success'); addLog(message, 'success'); addLog(`복사된 주소: ${linkToCopy}`); } else if (downloadableLinks.length > 1) { showToast(`${downloadableLinks.length}개 파일이 있어 RD 페이지로 이동합니다.`, "info"); addLog(`${downloadableLinks.length}개 파일이 감지되어 RD 다운로더 페이지를 엽니다.`); await openRdDownloaderPage(torrentId, button); } else { throw new Error("유효한 다운로드 링크를 생성하지 못했습니다."); } } catch (error) { const errorMessage = `링크 처리 실패: ${error.message}`; showToast(errorMessage, "error"); addLog(errorMessage, 'error'); } finally { if (!button.disabled) { setLoading(button, false); } } }
async function getTorrentInfo(torrentId, button) { const MIN_FILE_SIZE_BYTES = 500 * 1024 * 1024; setLoading(button, true); showToast("다운로드 링크를 생성 중입니다...", "info"); try { addLog(`ID ${torrentId}: 1단계 - 파일 정보 및 링크를 조회합니다.`); const info = await makeApiCall(`/torrents/info/${torrentId}`); if (!info || !info.files || info.files.length === 0) { throw new Error("다운로드할 파일 정보를 찾을 수 없습니다."); } const filesWithLinks = info.files.map((file, index) => ({...file, privateLink: info.links[index]})); const filesToProcess = filesWithLinks.filter(file => file.bytes >= MIN_FILE_SIZE_BYTES); const hiddenFilesCount = filesWithLinks.length - filesToProcess.length; if (filesToProcess.length === 0) { throw new Error(`모든 파일이 ${formatSize(MIN_FILE_SIZE_BYTES)} 미만이라 처리할 파일이 없습니다.`); } addLog(`ID ${torrentId}: 2단계 - ${filesToProcess.length}개의 유효한 파일을 변환합니다... (${hiddenFilesCount}개 숨김)`); const unrestrictPromises = filesToProcess.map(file => makeApiCall('/unrestrict/link', { method: 'POST', headers: { 'Content-Type': 'application/x-form-urlencoded' }, body: `link=${encodeURIComponent(file.privateLink)}`}).then(result => ({ ...file, ...result })).catch(err => { addLog(`'${file.path}' 링크 변환 실패: ${err.message}`, 'warning'); return { ...file, error: true }; })); const filesWithRealLinks = (await Promise.all(unrestrictPromises)).filter(f => f && f.download && !f.error); if (filesWithRealLinks.length === 0) { throw new Error("모든 유효 파일의 링크를 생성하지 못했습니다."); } const fileListHTML = filesWithRealLinks.map(file => { const isStreamable = file.streamingLink && /\.(mkv|mp4|avi|mov|wmv|flv)$/i.test(file.path); return `<li class="p-2 my-1 border border-gray-200 rounded-md flex justify-between items-center text-sm hover:bg-gray-50 transition-colors"><span class="flex-1 mr-2 break-all text-gray-800"><i class="fas ${isStreamable ? 'fa-file-video' : 'fa-file-alt'} mr-2 text-gray-500"></i>${file.path} <span class="text-gray-500">(${formatSize(file.bytes)})</span></span><div class="flex-shrink-0 flex items-center gap-2"><button onclick="navigator.clipboard.writeText('${file.download}'); showToast('링크가 복사되었습니다.', 'success');" class="px-3 py-1 bg-blue-500 text-white text-xs font-semibold rounded-lg hover:bg-blue-600 whitespace-nowrap"><i class="fas fa-copy mr-1"></i>링크 복사</button>${isStreamable ? `<a href="${file.streamingLink}" target="_blank" class="px-3 py-1 bg-purple-600 text-white text-xs font-semibold rounded-lg hover:bg-purple-700 whitespace-nowrap"><i class="fas fa-play mr-1"></i>스트리밍</a>` : ''}<a href="${file.download}" target="_blank" class="px-3 py-1 bg-green-600 text-white text-xs font-semibold rounded-lg hover:bg-green-700 whitespace-nowrap"><i class="fas fa-download mr-1"></i>다운로드</a></div></li>`; }).join(''); const modalHTML = `<div id="nativeDownloaderModal" class="fixed inset-0 bg-black bg-opacity-60 flex items-center justify-center z-50 p-4 fade-in" onclick="this.remove()"><div class="bg-white rounded-lg shadow-2xl p-6 max-w-4xl w-full max-h-[90vh] flex flex-col" onclick="event.stopPropagation()"><div class="flex justify-between items-center mb-4 border-b border-gray-200 pb-3"><h3 class="text-xl font-semibold text-gray-800 flex-shrink-1 mr-4 overflow-hidden text-ellipsis whitespace-nowrap" title="${info.filename}">${info.filename}</h3><button onclick="document.getElementById('nativeDownloaderModal').remove()" class="text-gray-500 hover:text-gray-800 text-2xl font-bold">&times;</button></div><div id="file-list-container" class="overflow-y-auto flex-grow pr-2">${hiddenFilesCount > 0 ? `<p class="text-sm text-gray-600 mb-3 p-2 bg-gray-100 rounded-md text-center"><i class="fas fa-info-circle mr-2 text-gray-500"></i>${hiddenFilesCount}개의 저용량 파일(${formatSize(MIN_FILE_SIZE_BYTES)} 미만)이 목록에서 자동으로 제외되었습니다.</p>` : ''}<ul class="space-y-1">${fileListHTML}</ul></div><div class="mt-4 pt-4 border-t border-gray-200 flex justify-end"><button onclick="document.getElementById('nativeDownloaderModal').remove()" class="px-4 py-2 bg-gray-600 text-white rounded-lg hover:bg-gray-700">닫기</button></div></div></div>`; document.body.insertAdjacentHTML('beforeend', modalHTML); addLog(`ID ${torrentId}: 3단계 - 다운로더 팝업을 표시했습니다. (성공: ${filesWithRealLinks.length}/${filesToProcess.length})`); showToast("링크 생성 완료!", "success"); } catch (error) { showToast(`링크 생성 중 오류: ${error.message}`, "error"); addLog(`링크 생성 실패 (ID: ${torrentId}): ${error.message}`, 'error'); showToast("자동 링크 생성에 실패하여 RD 페이지를 엽니다.", "info"); openRdDownloaderPage(torrentId, button); } finally { setLoading(button, false); } }
async function testConnection() { const apiCombinedStatusEl = document.getElementById('apiCombinedStatus'); apiCombinedStatusEl.innerHTML = `<span class="font-bold text-yellow-500">확인 중...</span>`; try { addLog("API 연결을 테스트합니다..."); const user = await makeApiCall("/user"); showToast(`연결 성공! 사용자: ${user.username}`, "success"); addLog(`API 연결 성공 - 사용자: ${user.username}`, "success"); if (user.type === 'premium' && user.expiration) { const expirationDate = new Date(user.expiration); const now = new Date(); const diffDays = Math.ceil((expirationDate - now) / (1000 * 60 * 60 * 24)); const formattedExpiration = expirationDate.toLocaleString('ko-KR', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }); let dDayText = `D-${diffDays}`; let colorClass = 'text-green-600'; if (diffDays <= 0) { dDayText = '만료'; colorClass = 'text-red-600'; } else if (diffDays <= 7) { colorClass = 'text-yellow-600'; showToast(`프리미엄 만료일이 ${diffDays}일 남았습니다.`, 'warning'); } apiCombinedStatusEl.innerHTML = `<span class="font-semibold ${colorClass}">${formattedExpiration} (<span class="font-black">${dDayText}</span>)</span>, <span class="font-bold text-blue-600">${user.points}P</span>`; } else { apiCombinedStatusEl.innerHTML = `<span class="font-bold text-red-600">프리미엄 아님</span>`; } } catch (e) { showToast(`연결 실패: ${e.message}`, "error"); apiCombinedStatusEl.innerHTML = `<span class="font-bold text-red-500" title="${e.message}">연결 실패</span>`; } }

// ============== 앱 초기화 및 이벤트 리스너 ==============
function initializeApp(){
    const savedToken = localStorage.getItem("rdToken") || "";
    document.getElementById("apiToken").value = savedToken;
    addLog("페이지가 로드되었습니다.");
    if (savedToken) {
        testConnection();
    } else {
        addLog("API 토큰이 설정되지 않았습니다. 토큰을 입력하고 저장해주세요.", "warning");
        const apiCombinedStatusEl = document.getElementById('apiCombinedStatus');
        apiCombinedStatusEl.innerHTML = `<span class="font-bold text-gray-500">토큰 없음</span>`;
        document.getElementById('apiListSize').textContent = '';
    }
    fetchBestTrackers();
    startOrResetRefreshCycle();
    
    const dropZone = document.getElementById("dropZone");
    const fileInput = document.getElementById("torrentFile");
    
    // ★★★ 파일 입력(input)과 드롭(drop) 이벤트 핸들러 수정
    fileInput.addEventListener("change", handleFileSelectionChange);
    dropZone.addEventListener("click", () => fileInput.click());
    
    ["dragover", "dragleave", "drop"].forEach(eventName => {
        dropZone.addEventListener(eventName, e => { e.preventDefault(); e.stopPropagation(); });
    });
    ["dragenter", "dragover"].forEach(eventName => {
        dropZone.addEventListener(eventName, () => dropZone.classList.add("border-blue-400", "bg-blue-50"));
    });
    ["dragleave", "drop"].forEach(eventName => {
        dropZone.addEventListener(eventName, () => dropZone.classList.remove("border-blue-400", "bg-blue-50"));
    });
    
    dropZone.addEventListener("drop", event => {
        const files = event.dataTransfer.files;
        if (files.length > 0 && files[0].name.endsWith(".torrent")) {
            fileInput.files = files;
            handleFileSelectionChange(); // ★★★ UI 업데이트 함수 호출
        } else {
            showToast("유효한 .torrent 파일이 아닙니다", "error");
        }
    });

    const magnetInput = document.getElementById('magnetInput');
    const magnetPlaceholder = document.getElementById('magnetPlaceholder');
    magnetInput.addEventListener('input', () => { if (magnetInput.value !== '') { magnetPlaceholder.classList.add('opacity-0'); } else { magnetPlaceholder.classList.remove('opacity-0'); } });
    magnetInput.addEventListener('focus', () => magnetPlaceholder.classList.add('opacity-0'));
    magnetInput.addEventListener('blur', () => { if (magnetInput.value === '') magnetPlaceholder.classList.remove('opacity-0'); });
}

document.addEventListener("DOMContentLoaded", initializeApp);
