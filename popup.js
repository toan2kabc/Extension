class CaiLoExtension {
    constructor() {
        this.blockedDomains = [];
        this.currentFilter = 'all';
        this.isEnabled = true;
        this.selectedMode = 'detox'; // 'detox' or 'normal'
        this.stats = {
            totalBlocked: 0,
            todayBlocked: 0,
            detoxActive: 0
        };
        
        // DETOX DATA STRUCTURE
        this.detoxData = {}; // {domain: {config}}
        this.detoxSettings = {
            initialTime: 60,    // 60 minutes on day 1
            dailyDecrease: 10,  // Decrease 10 minutes per day
            minTime: 5,         // Minimum 5 minutes
            resetHour: 0        // Reset at 0:00 daily
        };
        
        this.timeUpdateInterval = null;
        this.init();
    }
    
    async init() {
        await this.loadData();
        this.setupEventListeners();
        this.render();
        this.updateLastUpdateTime();
        this.startTimeUpdateInterval();
    }
    
    async loadData() {
        try {
            const data = await chrome.storage.local.get([
                'blockedDomains', 
                'isEnabled', 
                'stats',
                'detoxData',
                'selectedMode'
            ]);
            
            if (data.blockedDomains) {
                this.blockedDomains = data.blockedDomains;
            } else {
                this.blockedDomains = await this.getDefaultDomains();
            }
            
            if (data.isEnabled !== undefined) {
                this.isEnabled = data.isEnabled;
            }
            
            if (data.stats) {
                this.stats = data.stats;
            }
            
            if (data.detoxData) {
                this.detoxData = data.detoxData;
                this.resetDailyTimeLimits(); // Reset daily time
            }
            
            if (data.selectedMode) {
                this.selectedMode = data.selectedMode;
            }
            
            this.updateStats();
        } catch (error) {
            console.error('Error loading data:', error);
        }
    }
    
    async saveData() {
        try {
            await chrome.storage.local.set({
                blockedDomains: this.blockedDomains,
                isEnabled: this.isEnabled,
                stats: this.stats,
                detoxData: this.detoxData,
                selectedMode: this.selectedMode
            });
            
            chrome.runtime.sendMessage({
                type: 'UPDATE_BLOCKED_DOMAINS',
                data: {
                    blockedDomains: this.blockedDomains,
                    isEnabled: this.isEnabled,
                    detoxData: this.detoxData,
                    selectedMode: this.selectedMode
                }
            });
        } catch (error) {
            console.error('Error saving data:', error);
        }
    }
    
    // DETOX: Reset daily time limits
    resetDailyTimeLimits() {
        const today = new Date().toDateString();
        let updated = false;
        
        for (const domain in this.detoxData) {
            const data = this.detoxData[domain];
            const lastResetDate = new Date(data.lastReset).toDateString();
            
            if (lastResetDate !== today) {
                // New day, calculate new limit
                const daysSinceStart = Math.floor((Date.now() - data.startDate) / (1000 * 60 * 60 * 24));
                let newDailyLimit = this.detoxSettings.initialTime - (daysSinceStart * this.detoxSettings.dailyDecrease);
                
                // Ensure not below minimum
                newDailyLimit = Math.max(newDailyLimit, this.detoxSettings.minTime);
                
                // Update detox data
                this.detoxData[domain] = {
                    ...data,
                    dailyLimit: newDailyLimit,
                    remainingTime: newDailyLimit,
                    lastReset: Date.now(),
                    usedTimeToday: 0
                };
                
                updated = true;
            }
        }
        
        if (updated) {
            this.saveData();
            this.renderDomainList();
        }
    }
    
    // DETOX: Get remaining time info
    getRemainingTimeInfo(domain) {
        if (!this.detoxData[domain]) return null;
        
        const detox = this.detoxData[domain];
        const today = new Date().toDateString();
        const lastResetDate = new Date(detox.lastReset).toDateString();
        
        if (lastResetDate !== today) {
            this.resetDailyTimeLimits();
            return this.getRemainingTimeInfo(domain);
        }
        
        return {
            remaining: detox.remainingTime,
            dailyLimit: detox.dailyLimit,
            usedToday: detox.usedTimeToday,
            nextDecrease: Math.max(this.detoxSettings.minTime, detox.dailyLimit - this.detoxSettings.dailyDecrease),
            daysInDetox: Math.floor((Date.now() - detox.startDate) / (1000 * 60 * 60 * 24)) + 1
        };
    }
    
    // DETOX: Record time usage
    recordDomainUsage(domain, minutes) {
        if (!this.detoxData[domain]) return null;
        
        const detox = this.detoxData[domain];
        const today = new Date().toDateString();
        const lastResetDate = new Date(detox.lastReset).toDateString();
        
        if (lastResetDate !== today) {
            this.resetDailyTimeLimits();
            return this.recordDomainUsage(domain, minutes);
        }
        
        // Update usage
        detox.usedTimeToday += minutes;
        detox.remainingTime = Math.max(0, detox.dailyLimit - detox.usedTimeToday);
        detox.totalUsedTime = (detox.totalUsedTime || 0) + minutes;
        detox.lastUpdate = Date.now();
        
        this.saveData();
        
        // Check if time limit exceeded
        if (detox.remainingTime <= 0) {
            this.showTimeLimitExceeded(domain);
        }
        
        return detox.remainingTime;
    }
    
    // DETOX: Show time limit exceeded notification
    showTimeLimitExceeded(domain) {
        const now = new Date();
        const tomorrow = new Date(now);
        tomorrow.setDate(tomorrow.getDate() + 1);
        tomorrow.setHours(0, 0, 0, 0);
        
        const hoursUntilReset = Math.ceil((tomorrow - now) / (1000 * 60 * 60));
        
        this.showNotification(
            `⏰ ${domain}: ĐÃ HẾT THỜI GIAN!\n⏳ Reset sau: ${hoursUntilReset} giờ`,
            'error'
        );
        
        // Notify background to block completely
        chrome.runtime.sendMessage({
            type: 'TIME_LIMIT_EXCEEDED',
            domain: domain
        });
    }
    
    // DETOX: Update detox stats display
    updateDetoxStats() {
        const detoxDomains = this.blockedDomains.filter(d => d.detoxMode).length;
        const activeDetox = Object.keys(this.detoxData).length;
        
        // Update counters
        document.getElementById('detoxActive').textContent = activeDetox;
        document.getElementById('detoxCount').textContent = detoxDomains;
        document.getElementById('activeDetoxCount').textContent = activeDetox;
        
        // Update progress bar
        if (activeDetox > 0) {
            const totalTimeReduction = detoxDomains * this.detoxSettings.dailyDecrease;
            const progressFill = document.getElementById('detoxProgressFill');
            const detoxInfo = document.getElementById('detoxInfo');
            
            progressFill.style.width = '50%'; // Placeholder
            detoxInfo.textContent = `${activeDetox}/${detoxDomains} sites`;
        }
    }
    
    // Setup event listeners
    setupEventListeners() {
        // Global toggle
        const globalToggle = document.getElementById('globalToggle');
        globalToggle.checked = this.isEnabled;
        globalToggle.addEventListener('change', (e) => {
            this.isEnabled = e.target.checked;
            this.saveData();
            this.showNotification(
                this.isEnabled ? 'Đã bật chế độ cai nghiện' : 'Đã tắt chế độ cai nghiện',
                this.isEnabled ? 'success' : 'warning'
            );
        });
        
        // Mode selection
        document.querySelectorAll('.option-card').forEach(card => {
            card.addEventListener('click', (e) => {
                document.querySelectorAll('.option-card').forEach(c => c.classList.remove('active'));
                card.classList.add('active');
                this.selectedMode = card.dataset.mode;
                this.saveData();
            });
        });
        
        // Set initial mode
        document.querySelector(`[data-mode="${this.selectedMode}"]`)?.classList.add('active');
        
        // Add domain button
        document.getElementById('addButton').addEventListener('click', () => this.addDomain());
        
        // Domain input
        const domainInput = document.getElementById('domainInput');
        domainInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                this.addDomain();
            }
        });
        
        // Filter tabs
        document.querySelectorAll('.filter-tab').forEach(tab => {
            tab.addEventListener('click', (e) => {
                document.querySelectorAll('.filter-tab').forEach(t => t.classList.remove('active'));
                e.currentTarget.classList.add('active');
                this.currentFilter = e.currentTarget.dataset.filter;
                this.renderDomainList();
            });
        });
        
        // Clear all button
        document.getElementById('clearAllButton').addEventListener('click', () => this.clearAllDomains());
        
        // Export button
        document.getElementById('exportButton').addEventListener('click', () => this.exportDomains());
        
        // Import button
        document.getElementById('importButton').addEventListener('click', () => this.importDomains());
        
        // Stats button
        document.getElementById('statsButton').addEventListener('click', () => this.showStats());
        
        // Settings button
        document.getElementById('settingsButton').addEventListener('click', () => this.openSettings());
        
        // Help button
        document.getElementById('helpButton').addEventListener('click', () => this.openHelp());
        
        // Listen for messages from background
        chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
            this.handleBackgroundMessage(message, sender, sendResponse);
            return true;
        });
    }
    
    // Handle background messages
    handleBackgroundMessage(message, sender, sendResponse) {
        switch (message.type) {
            case 'TIME_USAGE_UPDATE':
                if (message.domain && message.minutes) {
                    const remaining = this.recordDomainUsage(message.domain, message.minutes);
                    this.renderDomainList();
                    
                    if (remaining !== null && remaining < 5) {
                        this.showNotification(
                            `⏰ ${message.domain}: Còn ${Math.ceil(remaining)} phút!`,
                            'warning'
                        );
                    }
                }
                sendResponse({ success: true });
                break;
                
            case 'DETOX_INFO_REQUEST':
                const info = this.getRemainingTimeInfo(message.domain);
                sendResponse({ info });
                break;
                
            case 'DETOX_RESET_NOTIFICATION':
                this.showNotification(
                    `🔄 Đã reset thời gian cho ${message.count} website`,
                    'info'
                );
                this.renderDomainList();
                sendResponse({ success: true });
                break;
        }
    }
    
    // Add domain with detox mode
    async addDomain() {
        const input = document.getElementById('domainInput');
        const domain = input.value.trim().toLowerCase();
        
        if (!domain) {
            this.showNotification('Vui lòng nhập tên miền', 'error');
            input.focus();
            return;
        }
        
        if (!this.isValidDomain(domain)) {
            this.showNotification('Tên miền không hợp lệ', 'error');
            input.focus();
            return;
        }
        
        if (this.blockedDomains.some(d => d.name === domain)) {
            this.showNotification(`${domain} đã có trong danh sách`, 'info');
            input.focus();
            return;
        }
        
        const useDetoxMode = this.selectedMode === 'detox';
        const category = this.determineCategory(domain);
        const now = Date.now();
        
        const newDomain = {
            id: this.generateId(),
            name: domain,
            category: category,
            addedAt: now,
            blockedCount: 0,
            detoxMode: useDetoxMode,
            detoxStartDate: useDetoxMode ? now : null
        };
        
        this.blockedDomains.unshift(newDomain);
        
        // Initialize detox data if in detox mode
        if (useDetoxMode) {
            this.detoxData[domain] = {
                dailyLimit: this.detoxSettings.initialTime,
                remainingTime: this.detoxSettings.initialTime,
                startDate: now,
                lastReset: now,
                lastUpdate: now,
                usedTimeToday: 0,
                totalUsedTime: 0,
                daysInDetox: 1
            };
            
            const days = Math.floor((Date.now() - now) / (1000 * 60 * 60 * 24)) + 1;
            const limit = this.detoxSettings.initialTime - ((days - 1) * this.detoxSettings.dailyDecrease);
            
            this.showNotification(
                `✅ Đã bắt đầu cai nghiện ${domain}\n` +
                `📅 Ngày ${days}: ${Math.max(this.detoxSettings.minTime, limit)} phút/ngày\n` +
                `⏱️ Hôm nay: ${this.detoxSettings.initialTime} phút`,
                'success'
            );
        } else {
            this.showNotification(`✅ Đã chặn ${domain} (chế độ thường)`, 'success');
        }
        
        input.value = '';
        
        await this.saveData();
        this.renderDomainList();
        this.updateStats();
        this.updateDetoxStats();
        this.updateLastUpdateTime();
        
        // Notify content script
        chrome.tabs.query({active: true, currentWindow: true}, (tabs) => {
            if (tabs[0]) {
                chrome.tabs.sendMessage(tabs[0].id, {
                    type: 'DOMAIN_BLOCKED',
                    domain: domain,
                    detoxMode: useDetoxMode
                });
            }
        });
    }
    
    // Render domain list with detox info
    renderDomainList() {
        const listContainer = document.getElementById('domainList');
        const emptyState = document.getElementById('emptyState');
        
        let filteredDomains = this.blockedDomains;
        if (this.currentFilter !== 'all') {
            if (this.currentFilter === 'detox') {
                filteredDomains = this.blockedDomains.filter(d => d.detoxMode);
            } else {
                filteredDomains = this.blockedDomains.filter(d => d.category === this.currentFilter);
            }
        }
        
        if (filteredDomains.length === 0) {
            listContainer.innerHTML = '';
            emptyState.style.display = 'block';
            return;
        }
        
        emptyState.style.display = 'none';
        
        listContainer.innerHTML = filteredDomains.map(domain => {
            const timeInfo = this.getRemainingTimeInfo(domain.name);
            const hasDetox = domain.detoxMode;
            
            // Determine time display class
            let timeClass = 'time-normal';
            if (timeInfo) {
                if (timeInfo.remaining < 5) timeClass = 'time-critical';
                else if (timeInfo.remaining < 15) timeClass = 'time-warning';
            }
            
            // Format time display
            let timeDisplay = '';
            if (timeInfo) {
                const minutes = Math.floor(timeInfo.remaining);
                const seconds = Math.floor((timeInfo.remaining - minutes) * 60);
                timeDisplay = `
                    <div class="domain-time-limit ${timeClass}">
                        <i class="fas fa-hourglass-half"></i>
                        <span class="time-text">${minutes}:${seconds.toString().padStart(2, '0')}</span>
                        <span class="time-label">/${timeInfo.dailyLimit}p</span>
                    </div>
                `;
            }
            
            return `
                <li class="domain-item ${hasDetox ? 'detox-mode' : ''}" data-id="${domain.id}">
                    <div class="domain-header">
                        <div class="domain-icon ${hasDetox ? 'detox-icon' : ''}">
                            <i class="fas ${this.getCategoryIcon(domain.category)}"></i>
                            ${hasDetox ? '<div class="detox-badge">⏰</div>' : ''}
                        </div>
                        <div class="domain-info">
                            <div class="domain-name">${domain.name}</div>
                            <div class="domain-meta">
                                <span class="domain-category">${this.getCategoryLabel(domain.category)}</span>
                                ${hasDetox ? `<span class="detox-label">Cai nghiện ngày ${timeInfo?.daysInDetox || 1}</span>` : ''}
                                <span class="domain-time">
                                    <i class="far fa-clock"></i>
                                    ${this.formatTime(domain.addedAt)}
                                </span>
                                ${timeDisplay}
                            </div>
                        </div>
                        <div class="domain-actions">
                            <button class="remove-button" data-domain="${domain.name}" title="Xóa">
                                <i class="fas fa-times"></i>
                            </button>
                        </div>
                    </div>
                </li>
            `;
        }).join('');
        
        // Update counts
        this.updateCategoryCounts();
        
        // Add event listeners
        document.querySelectorAll('.remove-button').forEach(button => {
            button.addEventListener('click', (e) => {
                e.stopPropagation();
                const domainName = button.dataset.domain;
                this.removeDomain(domainName);
            });
        });
        
        document.querySelectorAll('.domain-item').forEach(item => {
            item.addEventListener('click', (e) => {
                if (!e.target.closest('.remove-button')) {
                    const domainId = item.dataset.id;
                    this.showDomainDetails(domainId);
                }
            });
        });
    }
    
    // Remove domain
    removeDomain(domainName) {
        if (confirm(`Bạn có chắc muốn gỡ chặn ${domainName}?${this.detoxData[domainName] ? '\n\nDữ liệu cai nghiện sẽ bị xóa!' : ''}`)) {
            // Remove from blocked domains
            this.blockedDomains = this.blockedDomains.filter(d => d.name !== domainName);
            
            // Remove detox data if exists
            if (this.detoxData[domainName]) {
                delete this.detoxData[domainName];
            }
            
            this.saveData();
            this.renderDomainList();
            this.updateStats();
            this.updateDetoxStats();
            this.showNotification(`Đã gỡ chặn ${domainName}`, 'info');
        }
    }
    
    // Clear all domains
    clearAllDomains() {
        if (this.blockedDomains.length === 0) {
            this.showNotification('Danh sách đã trống', 'info');
            return;
        }
        
        const detoxCount = this.blockedDomains.filter(d => d.detoxMode).length;
        const message = detoxCount > 0 
            ? `Bạn có chắc muốn xóa tất cả ${this.blockedDomains.length} website?\n\nTrong đó có ${detoxCount} website đang cai nghiện!`
            : `Bạn có chắc muốn xóa tất cả ${this.blockedDomains.length} website?`;
        
        if (confirm(message)) {
            this.blockedDomains = [];
            this.detoxData = {};
            this.saveData();
            this.renderDomainList();
            this.updateStats();
            this.updateDetoxStats();
            this.showNotification('Đã xóa tất cả website', 'info');
        }
    }
    
    // Update stats
    updateStats() {
        this.stats.totalBlocked = this.blockedDomains.length;
        this.stats.todayBlocked = this.getTodayBlockedCount();
        this.stats.detoxActive = Object.keys(this.detoxData).length;
        
        document.getElementById('totalBlocked').textContent = this.stats.totalBlocked;
        document.getElementById('todayBlocked').textContent = this.stats.todayBlocked;
        document.getElementById('detoxActive').textContent = this.stats.detoxActive;
        
        this.updateCategoryCounts();
        this.updateDetoxStats();
    }
    
    updateCategoryCounts() {
        const socialCount = this.blockedDomains.filter(d => d.category === 'social').length;
        const gameCount = this.blockedDomains.filter(d => d.category === 'game').length;
        const detoxCount = this.blockedDomains.filter(d => d.detoxMode).length;
        
        document.getElementById('allCount').textContent = this.blockedDomains.length;
        document.getElementById('socialCount').textContent = socialCount;
        document.getElementById('gameCount').textContent = gameCount;
        document.getElementById('detoxCount').textContent = detoxCount;
    }
    
    // Start time update interval
    startTimeUpdateInterval() {
        if (this.timeUpdateInterval) {
            clearInterval(this.timeUpdateInterval);
        }
        
        this.timeUpdateInterval = setInterval(() => {
            this.updateDomainTimeDisplays();
        }, 10000); // Update every 10 seconds
    }
    
    // Update time displays
    updateDomainTimeDisplays() {
        const timeElements = document.querySelectorAll('.domain-time-limit .time-text');
        
        timeElements.forEach(element => {
            const domainItem = element.closest('.domain-item');
            if (!domainItem) return;
            
            const domainName = domainItem.querySelector('.domain-name')?.textContent;
            if (!domainName) return;
            
            const timeInfo = this.getRemainingTimeInfo(domainName);
            if (!timeInfo) return;
            
            const minutes = Math.floor(timeInfo.remaining);
            const seconds = Math.floor((timeInfo.remaining - minutes) * 60);
            
            element.textContent = `${minutes}:${seconds.toString().padStart(2, '0')}`;
            
            // Update class based on time
            const timeLimitElement = element.closest('.domain-time-limit');
            if (timeLimitElement) {
                timeLimitElement.className = 'domain-time-limit';
                if (timeInfo.remaining < 5) {
                    timeLimitElement.classList.add('time-critical');
                } else if (timeInfo.remaining < 15) {
                    timeLimitElement.classList.add('time-warning');
                } else {
                    timeLimitElement.classList.add('time-normal');
                }
            }
        });
    }
    
    // Helper methods
    getTodayBlockedCount() {
        const today = new Date().setHours(0, 0, 0, 0);
        return this.blockedDomains.filter(domain => {
            const domainDate = new Date(domain.addedAt).setHours(0, 0, 0, 0);
            return domainDate === today;
        }).length;
    }
    
    isValidDomain(domain) {
        const regex = /^(?!:\/\/)([a-zA-Z0-9-_]+\.)*[a-zA-Z0-9][a-zA-Z0-9-_]+\.[a-zA-Z]{2,}$/;
        return regex.test(domain);
    }
    
    determineCategory(domain) {
        const socialKeywords = ['facebook', 'instagram', 'tiktok', 'twitter', 'reddit', 'zalo'];
        const gameKeywords = ['game', 'chess', 'steam', 'epic', 'play', 'lichess'];
        
        if (socialKeywords.some(keyword => domain.includes(keyword))) return 'social';
        if (gameKeywords.some(keyword => domain.includes(keyword))) return 'game';
        return 'other';
    }
    
    getCategoryIcon(category) {
        const icons = {
            'social': 'fa-users',
            'game': 'fa-gamepad',
            'other': 'fa-globe'
        };
        return icons[category] || 'fa-globe';
    }
    
    getCategoryLabel(category) {
        const labels = {
            'social': 'MXH',
            'game': 'Game',
            'other': 'Khác'
        };
        return labels[category] || 'Khác';
    }
    
    formatTime(timestamp) {
        const now = Date.now();
        const diff = now - timestamp;
        
        const minute = 60 * 1000;
        const hour = 60 * minute;
        const day = 24 * hour;
        
        if (diff < minute) return 'Vừa xong';
        if (diff < hour) return `${Math.floor(diff / minute)} phút trước`;
        if (diff < day) return `${Math.floor(diff / hour)} giờ trước`;
        if (diff < 7 * day) return `${Math.floor(diff / day)} ngày trước`;
        
        return new Date(timestamp).toLocaleDateString('vi-VN');
    }
    
    updateLastUpdateTime() {
        const now = new Date();
        const timeString = now.toLocaleTimeString('vi-VN', { 
            hour: '2-digit', 
            minute: '2-digit' 
        });
        document.getElementById('lastUpdate').textContent = timeString;
    }
    
    generateId() {
        return Date.now().toString(36) + Math.random().toString(36).substr(2);
    }
    
    async getDefaultDomains() {
        return [];
    }
    
    // Show notification
    showNotification(message, type = 'info') {
        const notification = document.createElement('div');
        notification.className = `notification notification-${type}`;
        
        const icon = {
            'success': 'fa-check-circle',
            'error': 'fa-exclamation-circle',
            'warning': 'fa-exclamation-triangle',
            'info': 'fa-info-circle'
        }[type] || 'fa-info-circle';
        
        notification.innerHTML = `
            <i class="fas ${icon}"></i>
            <span>${message}</span>
        `;
        
        notification.style.cssText = `
            position: fixed;
            top: 20px;
            right: 20px;
            padding: 12px 20px;
            background: ${type === 'success' ? 'linear-gradient(135deg, #1DD1A1, #10B981)' :
                         type === 'error' ? 'linear-gradient(135deg, #FF6B6B, #FF4757)' :
                         type === 'warning' ? 'linear-gradient(135deg, #FF9F43, #F59E0B)' :
                         'linear-gradient(135deg, #2D2D44, #1A1A2E)'};
            color: ${type === 'success' ? '#0A0A0F' : '#F0F0F0'};
            border-radius: 8px;
            box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
            display: flex;
            align-items: center;
            gap: 10px;
            z-index: 1000;
            animation: slideIn 0.3s ease;
            font-size: 14px;
            font-weight: 500;
            max-width: 300px;
            border: 1px solid rgba(255, 255, 255, 0.1);
        `;
        
        const style = document.createElement('style');
        style.textContent = `
            @keyframes slideIn {
                from { transform: translateX(100%); opacity: 0; }
                to { transform: translateX(0); opacity: 1; }
            }
            @keyframes slideOut {
                from { transform: translateX(0); opacity: 1; }
                to { transform: translateX(100%); opacity: 0; }
            }
        `;
        document.head.appendChild(style);
        
        document.body.appendChild(notification);
        
        setTimeout(() => {
            notification.style.animation = 'slideOut 0.3s ease';
            setTimeout(() => notification.remove(), 300);
        }, 3000);
    }
    
    // Other methods
    exportDomains() {
        this.showNotification('Tính năng đang phát triển', 'info');
    }
    
    importDomains() {
        this.showNotification('Tính năng đang phát triển', 'info');
    }
    
    showStats() {
        const detoxCount = Object.keys(this.detoxData).length;
        const totalDetoxTime = Object.values(this.detoxData).reduce((sum, data) => sum + (data.totalUsedTime || 0), 0);
        const avgDailyReduction = detoxCount * this.detoxSettings.dailyDecrease;
        
        const statsMessage = `
            📊 THỐNG KÊ CAI NGHIỆN
            
            • Website đang cai: ${detoxCount}
            • Tổng thời gian tiết kiệm: ${Math.round(totalDetoxTime)} phút
            • Giảm trung bình: ${avgDailyReduction} phút/ngày
            • Tiến độ: ${this.getDetoxProgress()}%
            
            🎯 Mục tiêu: Giảm 10 phút/ngày/website
            ⏰ Reset hàng ngày lúc 0:00
        `;
        
        alert(statsMessage);
    }
    
    getDetoxProgress() {
        const detoxDomains = Object.keys(this.detoxData);
        if (detoxDomains.length === 0) return 0;
        
        const totalProgress = detoxDomains.reduce((sum, domain) => {
            const data = this.detoxData[domain];
            const days = Math.floor((Date.now() - data.startDate) / (1000 * 60 * 60 * 24)) + 1;
            const targetDays = (this.detoxSettings.initialTime - this.detoxSettings.minTime) / this.detoxSettings.dailyDecrease;
            return sum + Math.min(100, (days / targetDays) * 100);
        }, 0);
        
        return Math.round(totalProgress / detoxDomains.length);
    }
    
    showDomainDetails(domainId) {
        const domain = this.blockedDomains.find(d => d.id === domainId);
        if (!domain) return;
        
        const timeInfo = this.getRemainingTimeInfo(domain.name);
        let detailsMessage = `
            🌐 ${domain.name}
            📅 Thêm vào: ${new Date(domain.addedAt).toLocaleDateString('vi-VN')}
            📊 Đã chặn: ${domain.blockedCount || 0} lần
        `;
        
        if (domain.detoxMode && timeInfo) {
            detailsMessage += `
                
                🎯 CHẾ ĐỘ CAI NGHIỆN
                • Ngày thứ: ${timeInfo.daysInDetox}
                • Giới hạn hôm nay: ${timeInfo.dailyLimit} phút
                • Còn lại: ${Math.floor(timeInfo.remaining)} phút
                • Đã dùng: ${timeInfo.usedToday.toFixed(1)} phút
                • Ngày mai: ${timeInfo.nextDecrease} phút
                
                📈 Tiến độ: ${this.getDomainDetoxProgress(domain.name)}%
            `;
        }
        
        alert(detailsMessage);
    }
    
    getDomainDetoxProgress(domain) {
        const data = this.detoxData[domain];
        if (!data) return 0;
        
        const days = Math.floor((Date.now() - data.startDate) / (1000 * 60 * 60 * 24)) + 1;
        const targetDays = (this.detoxSettings.initialTime - this.detoxSettings.minTime) / this.detoxSettings.dailyDecrease;
        
        return Math.min(100, Math.round((days / targetDays) * 100));
    }
    
    openSettings() {
        this.showNotification('Cài đặt đang phát triển', 'info');
    }
    
    openHelp() {
        const helpMessage = `
            🆘 TRỢ GIÚP CAI LỌ DETOX
            
            🎯 CHẾ ĐỘ CAI NGHIỆN:
            • Ngày 1: 60 phút truy cập
            • Mỗi ngày giảm 10 phút
            • Tối thiểu: 5 phút/ngày
            • Reset lúc 0:00 hàng ngày
            
            ⚡ CÁCH DÙNG:
            1. Nhập domain cần cai nghiện
            2. Chọn "Cai nghiện" mode
            3. Website sẽ hiển thị thời gian còn lại
            4. Khi hết thời gian, website bị chặn hoàn toàn
            
            🎨 MÀU SẮC THỜI GIAN:
            • 🟢 Xanh: >15 phút
            • 🟡 Vàng: 5-15 phút  
            • 🔴 Đỏ: <5 phút
            
            📞 HỖ TRỢ: Tính năng đang phát triển
        `;
        
        alert(helpMessage);
    }
    
    render() {
        this.renderDomainList();
        this.updateStats();
        document.getElementById('globalToggle').checked = this.isEnabled;
    }
}

// Initialize extension
document.addEventListener('DOMContentLoaded', () => {
    const extension = new CaiLoExtension();
    window.caiLoExtension = extension;
    
    // Auto-update time every minute
    setInterval(() => {
        extension.updateLastUpdateTime();
    }, 60000);
});