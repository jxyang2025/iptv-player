document.addEventListener('DOMContentLoaded', () => {
    const iptvUrlInput = document.getElementById('iptv-url');
    const loadButton = document.getElementById('load-playlist');
    const directPlayButton = document.getElementById('direct-play'); // 获取直链播放按钮
    const channelListUl = document.getElementById('channels');
    const statusMessage = document.getElementById('status-message');
    const videoElement = document.getElementById('tv-player');
    
    // 初始化 Video.js 播放器
    const player = videojs(videoElement);

    // ==========================================================
    // !!! 关键配置: Cloudflare Worker 代理地址 !!!
    // ==========================================================
    // 确保这里是您的 Worker 的 HTTPS 地址，末尾包含斜杠 "/"。
    // 日志中显示您的 Worker 域名是 m3u.521986.xyz
    const WORKER_PROXY_BASE_URL = ''; 

    /**
     * 更新状态信息
     * @param {string} message - 要显示的消息
     * @param {string} type - 消息类型 ('info', 'error', 'success')
     */
    function updateStatus(message, type = 'info') {
        statusMessage.textContent = message;
        statusMessage.className = `p-2 rounded-lg text-sm transition-opacity duration-300 ${type === 'error' ? 'text-red-400 bg-red-900/50' : type === 'success' ? 'text-green-400 bg-green-900/50' : 'text-yellow-400 bg-yellow-900/50'}`;
        // 清除状态信息
        if (statusMessageTimeout) clearTimeout(statusMessageTimeout);
        statusMessageTimeout = setTimeout(() => {
            statusMessage.textContent = '';
            statusMessage.className = 'text-xs text-gray-500';
        }, 5000);
    }
    let statusMessageTimeout;

    /**
     * ⭐ 核心修复：清理用户输入的 URL，防止双重代理 ⭐
     * @param {string} url - 用户输入的 URL
     * @returns {string} 清理后的 URL
     */
    function cleanInputUrl(url) {
        // 编码后的代理基地址 (例如: https%3A%2F%2Fm3u.521986.xyz%2F)
        const encodedBase = encodeURIComponent(WORKER_PROXY_BASE_URL);
        // 代理链接结构 (例如: https://m3u.521986.xyz/?url=...)
        const proxyPrefix = `${WORKER_PROXY_BASE_URL}?url=`;
        
        let cleanedUrl = url;

        // 循环检测并移除多余的代理前缀
        let count = 0;
        const maxCleanIterations = 5; // 限制循环次数以防无限循环

        while (count < maxCleanIterations) {
            let changed = false;
            
            // 1. 检查未编码的代理前缀
            if (cleanedUrl.startsWith(proxyPrefix)) {
                cleanedUrl = cleanedUrl.substring(proxyPrefix.length);
                changed = true;
            }
            
            // 2. 检查双重编码的代理前缀 (例如: %3Furl%3Dhttps%3A%2F%2Fm3u.521986.xyz%2F)
            const doubleEncodedPrefix = encodeURIComponent(proxyPrefix);
            if (cleanedUrl.startsWith(doubleEncodedPrefix)) {
                // 这是一个非常罕见但可能发生的情况，如果用户粘贴了一个完全双重编码的 URL
                cleanedUrl = cleanedUrl.substring(doubleEncodedPrefix.length);
                changed = true;
            }

            // 3. 检查常见的编码代理前缀 (如果用户只粘贴了 ?url= 部分)
            if (cleanedUrl.startsWith('?url=') || cleanedUrl.startsWith('%3Furl%3D')) {
                cleanedUrl = cleanedUrl.substring(cleanedUrl.indexOf('=') + 1);
                changed = true;
            }
            
            // 4. 检查 URL 是否以编码的 Worker Base 开头
            if (cleanedUrl.startsWith(encodedBase)) {
                cleanedUrl = cleanedUrl.substring(encodedBase.length);
                changed = true;
            }

            if (!changed) break; // 没有变化，退出循环
            count++;
        }
        
        // 最终清理：确保解码
        try {
            // 尝试一次解码，以防内层 URL 是编码的
            return decodeURIComponent(cleanedUrl);
        } catch (e) {
            // 如果解码失败，返回原始字符串
            return cleanedUrl;
        }
    }


    /**
     * 获取 M3U 文件内容 (通过 Worker 代理)
     * @param {string} url - M3U/M3U8 文件的原始 URL
     * @returns {Promise<string|null>} M3U 文件内容或 null
     */
    async function fetchM3UContent(url) {
        // 使用 Worker 代理获取 M3U 内容，解决 CORS 问题
        const proxyUrl = `${WORKER_PROXY_BASE_URL}?url=${encodeURIComponent(url)}`;
        updateStatus('正在加载 M3U 文件...', 'info');

        try {
            const response = await fetch(proxyUrl);
            
            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`网络请求失败，状态码 ${response.status}。Worker 响应: ${errorText.substring(0, 100)}...`);
            }
            
            // 返回文本内容
            const content = await response.text();
            updateStatus('M3U 文件加载成功。', 'success');
            return content;
        } catch (error) {
            console.error('M3U 文件加载错误:', error);
            updateStatus(`加载 M3U 文件失败: ${error.message}`, 'error');
            return null;
        }
    }

    /**
     * 解析 M3U 文件内容为频道列表
     * @param {string} content - M3U 文件的文本内容
     * @returns {Array<Object>} 频道对象数组
     */
    function parseM3U(content) {
        const lines = content.split('\n');
        const channels = [];
        let currentName = '';

        for (const line of lines) {
            if (line.startsWith('#EXTINF:')) {
                // 提取频道名称
                const match = line.match(/,(.*)$/);
                currentName = match ? match[1].trim() : '未知频道';
            } else if (line.startsWith('http')) {
                // 找到流地址
                // 注意：这里存储的是 M3U 文件中找到的 **原始流地址**，它可能已经被 Worker 预重写了
                channels.push({ name: currentName, url: line.trim() });
                currentName = ''; // 重置名称
            }
        }
        return channels;
    }

    /**
     * 渲染频道列表到 DOM
     * @param {Array<Object>} channels - 频道对象数组
     */
    function renderChannels(channels) {
        channelListUl.innerHTML = '';
        if (channels.length === 0) {
            channelListUl.innerHTML = '<p class="p-2 text-gray-500">未找到任何频道。</p>';
            return;
        }

        channels.forEach(channel => {
            const listItem = document.createElement('li');
            listItem.className = 'p-2 hover:bg-gray-700 cursor-pointer transition duration-150';
            
            // 将流地址存储在 data-url 属性中
            // 无论它是原始地址还是已经被 Worker 重写的地址，我们都原样存储
            listItem.innerHTML = `<a href="#" class="block truncate text-sm" data-url="${channel.url}" data-name="${channel.name}">${channel.name}</a>`;
            channelListUl.appendChild(listItem);
        });
    }

    /**
     * 播放指定的频道流
     * @param {string} url - 频道的流地址
     * @param {string} name - 频道名称
     */
    function playChannel(url, name) {
        // ⭐ 关键修复: 检查链接是否已经指向 Worker 代理本身，防止双重代理 ⭐
        let finalUrl;
        if (url.startsWith(WORKER_PROXY_BASE_URL)) {
            // 如果链接已经是代理格式 (例如: worker.dev/?url=...)，则直接使用，避免二次封装
            finalUrl = url;
        } else {
            // 原始链接，进行代理封装
            finalUrl = `${WORKER_PROXY_BASE_URL}?url=${encodeURIComponent(url)}`;
        }
        
        console.log(`播放频道: ${name}, 最终 URL: ${finalUrl}`);
        updateStatus(`正在尝试播放频道: ${name}...`, 'info');

        const videoSource = finalUrl;
        
        // 1. 尝试使用 Hls.js (更健壮)
        if (Hls.isSupported() && videoElement.canPlayType('application/vnd.apple.mpegurl')) {
            const hls = new Hls();
            hls.loadSource(videoSource);
            hls.attachMedia(videoElement);
            hls.on(Hls.Events.MANIFEST_PARSED, function() {
                player.play().catch(e => console.log("Player autoplay blocked:", e));
                updateStatus(`频道播放中: ${name}`, 'success');
            });
            hls.on(Hls.Events.ERROR, function (event, data) {
                if (data.fatal) {
                    switch(data.type) {
                        case Hls.ErrorTypes.NETWORK_ERROR:
                            console.error("HLS.js: 致命网络错误，尝试恢复...");
                            hls.startLoad();
                            break;
                        case Hls.ErrorTypes.MEDIA_ERROR:
                            console.error("HLS.js: 致命媒体错误，尝试恢复...");
                            hls.recoverMediaError();
                            break;
                        default:
                            console.error(`HLS.js: 致命错误 (${data.details})，切换到 Video.js 原生模式...`);
                            // 失败时退回到原生 Video.js 处理
                            player.src({
                                src: videoSource,
                                type: 'application/x-mpegurl'
                            });
                            player.play().catch(e => console.log("Player autoplay blocked (fallback):", e));
                            updateStatus(`频道播放中: ${name} (原生回退)`, 'success');
                            break;
                    }
                }
            });
        } 
        // 2. 退回到 Video.js/浏览器原生支持 (针对 M3U8/HLS)
        else if (videoElement.canPlayType('application/vnd.apple.mpegurl') || videoElement.canPlayType('application/x-mpegurl')) {
            player.src({
                src: videoSource,
                type: 'application/x-mpegurl'
            });
            player.play().catch(e => console.log("Player autplay blocked:", e));
            updateStatus(`频道播放中: ${name}`, 'success');
        } 
        // 3. 都不支持
        else {
            updateStatus('错误: 您的浏览器不支持 HLS/M3U8 流播放。', 'error');
        }
    }

    // ==========================================================
    // 事件监听器
    // ==========================================================
    
    // 频道列表点击事件
    channelListUl.addEventListener('click', (event) => {
        const target = event.target.closest('a');
        if (target && target.dataset.url) {
            event.preventDefault(); // 阻止默认的链接跳转
            const url = target.dataset.url;
            const name = target.dataset.name;
            
            // 清理掉直链播放模式的本地存储
            localStorage.removeItem('directStreamUrl');
            
            // 移除所有激活状态，并添加当前激活状态
            channelListUl.querySelectorAll('li').forEach(li => li.classList.remove('bg-gray-600', 'border-l-4', 'border-blue-500'));
            target.parentElement.classList.add('bg-gray-600', 'border-l-4', 'border-blue-500');

            playChannel(url, name);
        }
    });


    // 1. M3U 列表加载
    loadButton.addEventListener('click', async () => {
        const m3uInput = iptvUrlInput.value.trim();
        if (!m3uInput) {
            updateStatus('请输入 M3U 订阅链接！', 'error');
            return;
        }

        // ⭐ 关键修复的应用：在加载前清理用户输入的 URL ⭐
        const m3uUrl = cleanInputUrl(m3uInput);

        // 保存清理后的 URL
        localStorage.setItem('iptvUrl', m3uUrl);
        localStorage.removeItem('directStreamUrl'); // 确保清除直链模式

        const m3uContent = await fetchM3UContent(m3uUrl);
        
        if (m3uContent) {
            const channels = parseM3U(m3uContent);
            renderChannels(channels);
            
            if (channels.length > 0) {
                // 默认播放第一个频道
                setTimeout(() => {
                    const firstChannel = document.querySelector('#channels li a');
                    firstChannel?.parentElement.classList.add('bg-gray-600', 'border-l-4', 'border-blue-500');
                    firstChannel?.click();
                }, 50); 
            } else {
                 updateStatus('M3U 文件已加载，但未找到任何频道。', 'error');
            }
        }
    });
    
    // 2. 直链播放 (单流模式)
    directPlayButton.addEventListener('click', () => {
        const streamInput = iptvUrlInput.value.trim();
        if (!streamInput) {
            updateStatus('请输入有效的流地址进行直链播放！', 'error');
            return;
        }
        
        // ⭐ 关键修复的应用：清理直链播放的 URL ⭐
        const streamUrl = cleanInputUrl(streamInput);

        // 清空频道列表
        channelListUl.innerHTML = '<p class="p-2 text-gray-500">当前为直链播放模式。</p>';
        localStorage.setItem('directStreamUrl', streamUrl);
        localStorage.removeItem('iptvUrl'); // 确保清除 M3U 模式

        const streamName = `直链流 (${streamUrl.substring(0, 40)}${streamUrl.length > 40 ? '...' : ''})`;

        playChannel(streamUrl, streamName);
    });

    
    // 3. 初始加载逻辑
    const storedM3uUrl = localStorage.getItem('iptvUrl');
    const storedStreamUrl = localStorage.getItem('directStreamUrl');

    if (storedM3uUrl) {
        iptvUrlInput.value = storedM3uUrl;
        // 自动触发 M3U 加载
        loadButton.click(); 
    } else if (storedStreamUrl) {
         iptvUrlInput.value = storedStreamUrl;
         // 自动触发直链播放
         directPlayButton.click(); 
    } else {
        updateStatus('等待输入 M3U 列表或流地址...', 'info');
    }
});

