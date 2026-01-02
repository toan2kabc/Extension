class ContentScript {
    constructor() {
        this.isEnabled = true;
        this.blockedDomains = [];
        this.detoxData = {};
        this.currentDomain = '';
        this.timeRemaining = null;
        this.timeOverlay = null;
        this.timeUpdateInterval = null;
        
        this.init();
    }
    
    async init() {
        await this.loadSettings();
        this.setupMessageListener();
        this.checkCurrentPage();
    }
    
    async loadSettings() {
        try {
            const response = await chrome.runtime.sendMessage({
                type: 'GET_BLOCKED_DOMAINS'
            });
            
            if (response) {
                this.isEnabled = response.isEnabled;
                this.blockedDomains = response.blockedDomains || [];
                this.detoxData = response.detoxData || {};
            }
        } catch (error) {
            console.error('Error loading settings:', error);
        }
    }
    
    setupMessageListener() {
        chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
            this.handleMessage(message, sender, sendResponse);
            return true;
        });
    }
    
    handleMessage(message, sender, sendResponse) {
        switch (message.type) {
            case 'DOMAIN_BLOCKED':
                this.blockedDomains.push({
                    name: message.domain,
                    detoxMode: message.detoxMode || false
                });
                if (message.detoxMode) {
                    this.detoxData[message.domain] = { remainingTime: 60 };
                }
                this.checkCurrentPage();
                sendResponse({ success: true });
                break;
                
            case 'UPDATE_TIME_REMAINING':
                if (window.location.hostname.includes(message.domain)) {
                    this.timeRemaining = message.remainingTime;
                    this.showTimeRemainingOverlay(message);
                }
                sendResponse({ success: true });
                break;
                
            case 'BLOCK_DUE_TO_TIME_LIMIT':
                if (window.location.hostname.includes(message.domain)) {
                    this.showTimeLimitExceededOverlay(message.domain);
                }
                sendResponse({ success: true });
                break;
                
            case 'CHECK_CURRENT_PAGE':
                const shouldBlock = this.shouldBlockCurrentPage();
                sendResponse({ shouldBlock });
                break;
        }
    }
    
    shouldBlockCurrentPage() {
        if (!this.isEnabled) return false;
        
        const currentUrl = window.location.href;
        const currentDomain = window.location.hostname;
        
        // Check if domain is blocked
        const blockedDomain = this.blockedDomains.find(d => 
            currentDomain === d.name || currentDomain.endsWith('.' + d.name)
        );
        
        if (!blockedDomain) return false;
        
        // Check detox mode
        if (blockedDomain.detoxMode && this.detoxData[blockedDomain.name]) {
            return this.detoxData[blockedDomain.name].remainingTime <= 0;
        }
        
        return true;
    }
    
    checkCurrentPage() {
        const shouldBlock = this.shouldBlockCurrentPage();
        
        if (shouldBlock) {
            const currentDomain = window.location.hostname;
            const blockedDomain = this.blockedDomains.find(d => 
                currentDomain === d.name || currentDomain.endsWith('.' + d.name)
            );
            
            if (blockedDomain?.detoxMode && this.detoxData[blockedDomain.name]) {
                // Show detox block page
                this.showDetoxBlockOverlay(blockedDomain.name);
            } else {
                // Show normal block page
                this.showBlockOverlay();
            }
            
            // Report back
            chrome.runtime.sendMessage({
                type: 'REPORT_BLOCKED',
                domain: currentDomain,
                url: window.location.href
            });
        } else {
            // Check if we should show time overlay
            const currentDomain = window.location.hostname;
            const detoxDomain = this.blockedDomains.find(d => 
                d.detoxMode && (currentDomain === d.name || currentDomain.endsWith('.' + d.name))
            );
            
            if (detoxDomain && this.detoxData[detoxDomain.name]) {
                this.currentDomain = detoxDomain.name;
                this.timeRemaining = this.detoxData[detoxDomain.name].remainingTime;
                this.requestTimeUpdate();
            }
        }
    }
    
    requestTimeUpdate() {
        if (!this.currentDomain) return;
        
        chrome.runtime.sendMessage({
            type: 'GET_DETOX_INFO',
            domain: this.currentDomain
        }, (response) => {
            if (response?.info) {
                this.timeRemaining = response.info.remaining;
                this.showTimeRemainingOverlay(response.info);
            }
        });
    }
    
    showDetoxBlockOverlay(domain) {
        this.removeExistingOverlays();
        
        const detoxInfo = this.detoxData[domain] || {};
        const dailyLimit = detoxInfo.dailyLimit || 60;
        const usedToday = detoxInfo.usedTimeToday || 0;
        
        const overlay = document.createElement('div');
        overlay.id = 'cailo-detox-block-overlay';
        
        const now = new Date();
        const tomorrow = new Date(now);
        tomorrow.setDate(tomorrow.getDate() + 1);
        tomorrow.setHours(0, 0, 0, 0);
        const hoursUntilReset = Math.ceil((tomorrow - now) / (1000 * 60 * 60));
        
        overlay.innerHTML = `
            <div class="detox-block-content">
                <div class="detox-icon">
                    <i class="fas fa-hourglass-end"></i>
                </div>
                <h1>⏰ HẾT THỜI GIAN CAI NGHIỆN</h1>
                <div class="domain-display">${domain}</div>
                
                <div class="detox-stats">
                    <div class="stat">
                        <div class="stat-value">${usedToday.toFixed(0)}/${dailyLimit}</div>
                        <div class="stat-label">Phút đã dùng/Hôm nay</div>
                    </div>
                    <div class="stat">
                        <div class="stat-value">${hoursUntilReset}</div>
                        <div class="stat-label">Giờ đến reset</div>
                    </div>
                </div>
                
                <div class="detox-message">
                    <p>Bạn đã sử dụng hết ${dailyLimit} phút cho hôm nay.</p>
                    <p>Thời gian sẽ được reset sau ${hoursUntilReset} giờ (vào lúc 0:00).</p>
                </div>
                
                <div class="detox-tips">
                    <h3>💡 Mẹo cai nghiện hiệu quả:</h3>
                    <ul>
                        <li>Ngày mai bạn sẽ có ${Math.max(5, dailyLimit - 10)} phút</li>
                        <li>Mỗi ngày giảm 10 phút cho đến khi còn 5 phút/ngày</li>
                        <li>Hãy tìm hoạt động thay thế lành mạnh hơn</li>
                    </ul>
                </div>
                
                <div class="actions">
                    <button id="cailo-go-back" class="btn-secondary">
                        <i class="fas fa-arrow-left"></i> Quay lại
                    </button>
                    <button id="cailo-manage" class="btn-primary">
                        <i class="fas fa-cog"></i> Quản lý cai nghiện
                    </button>
                </div>
                
                <div class="footer">
                    <i class="fas fa-heartbeat"></i> Cai Lọ Detox - Bạn đang làm rất tốt!
                </div>
            </div>
        `;
        
        overlay.style.cssText = this.getOverlayStyles();
        
        // Add Font Awesome
        this.addFontAwesome();
        
        document.body.appendChild(overlay);
        document.body.style.overflow = 'hidden';
        
        this.setupOverlayEvents(overlay);
    }
    
    showTimeRemainingOverlay(info) {
        if (!info || info.remaining <= 0) {
            this.removeTimeOverlay();
            return;
        }
        
        if (!this.timeOverlay) {
            this.createTimeOverlay();
        }
        
        this.updateTimeOverlay(info);
        
        // Start update interval
        if (!this.timeUpdateInterval) {
            this.timeUpdateInterval = setInterval(() => {
                if (this.timeRemaining > 0) {
                    this.timeRemaining -= 1/60; // Decrease by 1 second
                    this.updateTimeDisplay();
                    
                    if (this.timeRemaining <= 0) {
                        this.showTimeLimitExceededOverlay(this.currentDomain);
                    }
                }
            }, 1000);
        }
    }
    
    createTimeOverlay() {
        this.timeOverlay = document.createElement('div');
        this.timeOverlay.id = 'cailo-time-overlay';
        this.timeOverlay.style.cssText = `
            position: fixed;
            top: 20px;
            right: 20px;
            background: linear-gradient(135deg, rgba(26, 26, 46, 0.95), rgba(20, 20, 31, 0.98));
            border: 2px solid rgba(255, 107, 107, 0.3);
            border-radius: 16px;
            padding: 16px;
            color: #F0F0F0;
            font-family: -apple-system, BlinkMacSystemFont, sans-serif;
            z-index: 999998;
            box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
            backdrop-filter: blur(10px);
            min-width: 220px;
            transition: all 0.3s ease;
        `;
        
        document.body.appendChild(this.timeOverlay);
    }
    
    updateTimeOverlay(info) {
        if (!this.timeOverlay) return;
        
        const percent = (info.remaining / info.dailyLimit) * 100;
        const minutes = Math.floor(info.remaining);
        const seconds = Math.floor((info.remaining - minutes) * 60);
        
        // Determine color based on remaining time
        let borderColor = 'rgba(29, 209, 161, 0.3)'; // Green
        let timeColor = '#1DD1A1';
        
        if (info.remaining < 5) {
            borderColor = 'rgba(255, 107, 107, 0.5)'; // Red
            timeColor = '#FF6B6B';
            this.timeOverlay.style.animation = 'pulse-critical 1s infinite';
        } else if (info.remaining < 15) {
            borderColor = 'rgba(255, 159, 67, 0.3)'; // Orange
            timeColor = '#FF9F43';
            this.timeOverlay.style.animation = 'pulse-warning 2s infinite';
        } else {
            this.timeOverlay.style.animation = '';
        }
        
        this.timeOverlay.style.borderColor = borderColor;
        
        this.timeOverlay.innerHTML = `
            <div style="display: flex; align-items: center; gap: 12px;">
                <div style="position: relative; width: 48px; height: 48px;">
                    <svg width="48" height="48" viewBox="0 0 48 48">
                        <circle cx="24" cy="24" r="20" fill="none" stroke="rgba(255, 255, 255, 0.1)" stroke-width="4"/>
                        <circle cx="24" cy="24" r="20" fill="none" stroke="${timeColor}" 
                                stroke-width="4" stroke-linecap="round"
                                stroke-dasharray="${2 * Math.PI * 20}"
                                stroke-dashoffset="${2 * Math.PI * 20 * (1 - percent/100)}"
                                transform="rotate(-90 24 24)"/>
                    </svg>
                    <div style="position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); 
                                font-size: 10px; font-weight: bold; color: ${timeColor};">
                        ${Math.round(percent)}%
                    </div>
                </div>
                <div>
                    <div style="font-size: 12px; color: #A0A0B0; margin-bottom: 4px;">
                        <i class="fas fa-heartbeat"></i> Đang cai nghiện
                    </div>
                    <div style="font-size: 20px; font-weight: 700; font-family: 'Courier New', monospace; color: ${timeColor};">
                        ${minutes}:${seconds.toString().padStart(2, '0')}
                        <span style="font-size: 12px; color: #A0A0B0; margin-left: 4px;">
                            /${info.dailyLimit}p
                        </span>
                    </div>
                    <div style="font-size: 10px; color: #6B7280; margin-top: 4px;">
                        Giảm 10p/ngày • Reset 0:00
                    </div>
                </div>
            </div>
        `;
        
        // Add animations
        const style = document.createElement('style');
        style.textContent = `
            @keyframes pulse-warning {
                0%, 100% { box-shadow: 0 0 0 0 rgba(255, 159, 67, 0.4); }
                50% { box-shadow: 0 0 0 10px rgba(255, 159, 67, 0); }
            }
            @keyframes pulse-critical {
                0%, 100% { box-shadow: 0 0 0 0 rgba(255, 107, 107, 0.4); }
                50% { box-shadow: 0 0 0 10px rgba(255, 107, 107, 0); }
            }
        `;
        document.head.appendChild(style);
    }
    
    updateTimeDisplay() {
        if (!this.timeOverlay) return;
        
        const timeElement = this.timeOverlay.querySelector('div[style*="font-size: 20px"]');
        if (timeElement) {
            const minutes = Math.floor(this.timeRemaining);
            const seconds = Math.floor((this.timeRemaining - minutes) * 60);
            timeElement.innerHTML = `${minutes}:${seconds.toString().padStart(2, '0')}`;
        }
    }
    
    showTimeLimitExceededOverlay(domain) {
        this.removeTimeOverlay();
        this.showDetoxBlockOverlay(domain);
    }
    
    removeTimeOverlay() {
        if (this.timeOverlay) {
            this.timeOverlay.remove();
            this.timeOverlay = null;
        }
        
        if (this.timeUpdateInterval) {
            clearInterval(this.timeUpdateInterval);
            this.timeUpdateInterval = null;
        }
    }
    
    showBlockOverlay() {
        this.removeExistingOverlays();
        
        const overlay = document.createElement('div');
        overlay.id = 'cailo-block-overlay';
        overlay.innerHTML = this.getBlockOverlayHTML();
        overlay.style.cssText = this.getOverlayStyles();
        
        this.addFontAwesome();
        document.body.appendChild(overlay);
        document.body.style.overflow = 'hidden';
        
        this.setupOverlayEvents(overlay);
    }
    
    getBlockOverlayHTML() {
        return `
            <div class="block-content">
                <div class="block-icon">
                    <i class="fas fa-ban"></i>
                </div>
                <h1>WEBSITE ĐÃ BỊ CHẶN</h1>
                <div class="domain-display">${window.location.hostname}</div>
                <div class="block-message">
                    <p>Website này đã được thêm vào danh sách chặn để giúp bạn tập trung.</p>
                </div>
                <div class="actions">
                    <button id="cailo-go-back" class="btn-secondary">
                        <i class="fas fa-arrow-left"></i> Quay lại
                    </button>
                    <button id="cailo-manage" class="btn-primary">
                        <i class="fas fa-cog"></i> Quản lý chặn
                    </button>
                </div>
                <div class="footer">
                    <i class="fas fa-shield-alt"></i> Bảo vệ bởi Cai Lọ
                </div>
            </div>
        `;
    }
    
    getOverlayStyles() {
        return `
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: linear-gradient(135deg, #0A0A0F 0%, #14141F 100%);
            z-index: 999999;
            display: flex;
            align-items: center;
            justify-content: center;
            color: #F0F0F0;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            padding: 20px;
            text-align: center;
        `;
    }
    
    addFontAwesome() {
        if (!document.querySelector('link[href*="font-awesome"]')) {
            const link = document.createElement('link');
            link.rel = 'stylesheet';
            link.href = 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css';
            document.head.appendChild(link);
        }
    }
    
    setupOverlayEvents(overlay) {
        overlay.querySelector('#cailo-go-back')?.addEventListener('click', () => {
            window.history.back();
        });
        
        overlay.querySelector('#cailo-manage')?.addEventListener('click', () => {
            chrome.runtime.sendMessage({ type: 'OPEN_POPUP' });
        });
        
        this.disablePageInteraction();
    }
    
    disablePageInteraction() {
        // Prevent keyboard shortcuts
        const preventShortcuts = (e) => {
            if (e.ctrlKey || e.metaKey) {
                e.preventDefault();
                e.stopPropagation();
            }
        };
        
        document.addEventListener('keydown', preventShortcuts, true);
        
        // Prevent right-click
        document.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
        }, true);
    }
    
    removeExistingOverlays() {
        ['cailo-block-overlay', 'cailo-detox-block-overlay', 'cailo-time-overlay'].forEach(id => {
            const overlay = document.getElementById(id);
            if (overlay) overlay.remove();
        });
        
        document.body.style.overflow = '';
    }
}

// Initialize content script
const contentScript = new ContentScript();