document.addEventListener('DOMContentLoaded', () => {
    const iptvUrlInput = document.getElementById('iptv-url');
    const directUrlInput = document.getElementById('direct-url'); // 新增：直接播放输入框
    const loadButton = document.getElementById('load-playlist');
    const directPlayButton = document.getElementById('direct-play'); // 新增：直接播放按钮
    const channelListUl = document.getElementById('channels');
    const statusMessage = document.getElementById('status-message');
    const videoElement = document.getElementById('tv-player');
    
    // 初始化 Video.js 播放器
    const player = videojs(videoElement);

    // ==========================================================
    // !!! 关键配置: Cloudflare Worker 代理地址 !!!
    // ==========================================================
    const WORKER_PROXY_BASE_URL = 'https://m3u-proxy.jxy5460.workers.dev/';

    /**
     * 更新状态信息
     * @param {string} message - 要显示的消息
     * @param {string} type - 消息类型 ('info', 'error', 'success')
     */
    function updateStatus(message, type = 'info') {
        statusMessage.textContent = message;
        statusMessage.style.color = {
            'info': 'yellow',
            'error': 'red',
            'success': 'lightgreen'
        }[type] || 'yellow';
    }

    /**
     * 获取 M3U 文件内容 (通过 Worker 代理)
     * @param {string} url - M3U 订阅链接
     * @returns {Promise<string>} M3U 文件内容的文本
     */
    async function fetchM3UContent(url) {
        let fetchUrl = url;
        
        if (WORKER_PROXY_BASE_URL) {
            // 对 M3U 订阅链接使用 Worker 代理
            fetchUrl = WORKER_PROXY_BASE_URL + '?url=' + encodeURIComponent(url);
        }

        try {
            updateStatus('正在加载频道列表...');
            const response = await fetch(fetchUrl);
            
            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`网络请求失败，状态码: ${response.status}。Worker 错误信息: ${errorText.substring(0, 100)}`);
            }
            
            const text = await response.text();
            updateStatus('频道列表加载成功。', 'success');
            return text;
            
        } catch (error) {
            updateStatus(`加载失败: ${error.message}. 检查 URL 和 Worker 代理是否正确。`, 'error');
            console.error('Fetch M3U Error:', error);
            return null;
        }
    }
    
    /**
     * ⭐ 核心修改：解析 M3U 文本，按频道名称聚合源
     * @param {string} m3uText - M3U 文件的文本内容
     * @returns {Array<{name: string, sources: Array<{url: string, logo: string, tvgId: string}>}>} 聚合后的频道列表
     */
    function parseM3U(m3uText) {
        // 使用 Map 来按频道名称聚合源
        const channelMap = new Map();
        const lines = m3uText.split('\n').filter(line => line.trim() !== '');
        
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].startsWith('#EXTINF')) {
                const infoLine = lines[i];
                const urlLine = lines[i + 1];
                
                // 正则表达式提取名称、Logo、tvg-id等信息
                const nameMatch = infoLine.match(/,(.*)$/);
                const name = nameMatch ? nameMatch[1].trim() : '未知频道';
                
                const logoMatch = infoLine.match(/tvg-logo="([^"]*)"/);
                const logo = logoMatch ? logoMatch[1] : '';
                
                const tvgIdMatch = infoLine.match(/tvg-id="([^"]*)"/);
                const tvgId = tvgIdMatch ? tvgIdMatch[1] : '';

                if (urlLine && !urlLine.startsWith('#')) {
                    const source = {
                        url: urlLine.trim(),
                        logo: logo,
                        tvgId: tvgId
                    };
                    
                    if (channelMap.has(name)) {
                        channelMap.get(name).sources.push(source);
                    } else {
                        channelMap.set(name, {
                            name: name,
                            sources: [source]
                        });
                    }
                    i++; // 跳过 URL 行
                }
            }
        }
        return Array.from(channelMap.values());
    }

    /**
     * ⭐ 核心修改：渲染聚合后的频道列表，支持源切换
     * @param {Array<{name: string, sources: Array<{url: string, logo: string, tvgId: string}>}>} channels - 频道列表
     */
    function renderChannels(channels) {
        channelListUl.innerHTML = ''; // 清空现有列表

        if (channels.length === 0) {
            channelListUl.innerHTML = '<p>未找到任何频道。</p>';
            return;
        }

        channels.forEach((channel, index) => {
            const listItem = document.createElement('li');
            listItem.classList.add('channel-group');

            // 主频道链接 (默认播放第一个源)
            const mainLink = document.createElement('a');
            mainLink.href = '#';
            mainLink.textContent = `${channel.name} (${channel.sources.length}源)`;
            mainLink.classList.add('main-channel-link');
            
            // 存储当前激活的源索引
            mainLink.dataset.currentSourceIndex = 0; 
            
            // ⭐ 点击主链接：播放默认源并展开/收起源列表
            mainLink.addEventListener('click', (e) => {
                e.preventDefault();
                const sourceList = listItem.querySelector('.source-list');

                // 切换源列表的可见性
                sourceList.classList.toggle('visible');

                // 播放当前激活的源
                const sourceIndex = mainLink.dataset.currentSourceIndex || 0;
                const sourceUrl = channel.sources[sourceIndex].url;
                
                playChannel(sourceUrl, channel.name, sourceIndex);
                
                // 更新高亮状态
                document.querySelectorAll('.main-channel-link').forEach(a => a.classList.remove('active'));
                mainLink.classList.add('active');
            });

            listItem.appendChild(mainLink);

            // 源列表 (用于切换)
            const sourceList = document.createElement('ul');
            sourceList.classList.add('source-list');
            
            channel.sources.forEach((source, sourceIndex) => {
                const sourceItem = document.createElement('li');
                const sourceLink = document.createElement('a');
                sourceLink.href = '#';
                
                // 显示源序号和tvgId
                let linkText = `源 ${sourceIndex + 1}`;
                if (source.tvgId) {
                    linkText += ` (${source.tvgId})`;
                }
                sourceLink.textContent = linkText;
                sourceLink.dataset.url = source.url;
                
                // ⭐ 点击源链接：切换源并播放
                sourceLink.addEventListener('click', (e) => {
                    e.preventDefault();
                    
                    // 更新主链接的索引和高亮
                    mainLink.dataset.currentSourceIndex = sourceIndex;
                    document.querySelectorAll('.main-channel-link').forEach(a => a.classList.remove('active'));
                    mainLink.classList.add('active');
                    
                    // 播放新源
                    playChannel(source.url, channel.name, sourceIndex);
                    
                    // 可选：隐藏源列表
                    sourceList.classList.remove('visible'); 
                });
                
                sourceItem.appendChild(sourceLink);
                sourceList.appendChild(sourceItem);
            });

            listItem.appendChild(sourceList);
            channelListUl.appendChild(listItem);
        });
        
        // 默认播放第一个频道
        document.querySelector('.main-channel-link')?.click();
    }

    /**
     * 播放指定的频道流
     * @param {string} url - 频道流地址 (可能是原始M3U8链接或Worker代理后的链接)
     * @param {string} name - 频道名称
     * @param {number} [sourceIndex] - 源序号 (可选，用于显示)
     */
    function playChannel(url, name, sourceIndex = 0) {
        let display_name = `${name}`;
        if (sourceIndex > 0) {
            display_name += ` (源 ${sourceIndex + 1})`;
        }
        
        updateStatus(`正在播放: ${display_name}`, 'info');

        // 停止并清理旧的 HLS 实例
        if (player.hls) {
            player.hls.destroy();
            player.hls = null;
        }
        
        let proxiedUrl = url;
        
        // ⭐ 关键：判断是否需要代理
        // 只有手动输入的链接（不以 Worker 地址开头）才需要在这里封装代理。
        // M3U 列表中的源链接已由 Worker (index.js) 封装。
        if (WORKER_PROXY_BASE_URL && !url.startsWith(WORKER_PROXY_BASE_URL)) {
             proxiedUrl = WORKER_PROXY_BASE_URL + '?url=' + encodeURIComponent(url);
        }
        
        // 尝试使用 hls.js (推荐用于跨浏览器兼容性)
        if (Hls.isSupported()) {
            const hls = new Hls();
            player.hls = hls; // 存储实例以便后续清理
            
            // 使用代理后的 URL 加载流
            hls.loadSource(proxiedUrl);
            hls.attachMedia(videoElement);
            hls.on(Hls.Events.MANIFEST_PARSED, function() {
                player.play().catch(e => console.log("Player autplay blocked:", e));
                updateStatus(`频道播放中: ${display_name}`, 'success');
            });
            hls.on(Hls.Events.ERROR, function(event, data) {
                if (data.fatal) {
                     updateStatus(`播放错误 (${display_name}): 无法加载流或片段。请检查流地址是否有效。`, 'error');
                    console.error('HLS Fatal Error:', data);
                }
            });
        } 
        // 苹果等原生支持 HLS 的设备
        else if (videoElement.canPlayType('application/vnd.apple.mpegurl')) {
            videoElement.src = proxiedUrl;
            player.load();
            player.play().catch(e => console.log("Player autplay blocked:", e));
            updateStatus(`频道播放中: ${display_name}`, 'success');
        } 
        // 都不支持
        else {
            updateStatus('错误: 您的浏览器不支持 HLS/M3U8 流播放。', 'error');
        }
    }

    // ==========================================================
    // 事件监听器
    // ==========================================================
    loadButton.addEventListener('click', async () => {
        const m3uUrl = iptvUrlInput.value.trim();
        if (!m3uUrl) {
            updateStatus('请输入 M3U 订阅链接！', 'error');
            return;
        }

        const m3uContent = await fetchM3UContent(m3uUrl);
        
        if (m3uContent) {
            const channels = parseM3U(m3uContent);
            renderChannels(channels);
        }
    });
    
    // ⭐ 新增：直接播放按钮的事件监听器
// ⭐ app.js 中的 directPlayButton.addEventListener 修正:
directPlayButton.addEventListener('click', () => {
    const directUrl = directUrlInput.value.trim();
    if (!directUrl) {
        updateStatus('请输入要直接播放的源地址！', 'error');
        return;
    }
    // 直接播放，名称使用 URL 的一部分作为显示名称
    let name = directUrl.substring(directUrl.lastIndexOf('/') + 1);
    if (name.includes('?')) {
         name = name.substring(0, name.indexOf('?'));
    }
    // 播放手动源，不传递 sourceIndex，让它显示为不带 (源 x) 的名称
    playChannel(directUrl, `手动源: ${name}`); 
    
    // 清除列表高亮
    document.querySelectorAll('.main-channel-link').forEach(a => a.classList.remove('active'));
});

    // 从本地存储加载 URL (可选优化)
    const storedUrl = localStorage.getItem('iptvUrl');
    if (storedUrl) {
        iptvUrlInput.value = storedUrl;
    }
    // 监听输入框变化，保存 URL
    iptvUrlInput.addEventListener('change', () => {
        localStorage.setItem('iptvUrl', iptvUrlInput.value.trim());
    });
});

