// Background service worker for Cai Lo Detox
class BackgroundService {
    constructor() {
        this.blockedDomains = [];
        this.isEnabled = true;
        this.selectedMode = 'detox';
        this.detoxData = {};
        this.activeTimers = {};
        this.tabActivity = {};
        this.blockedCounts = {};
        
        this.init();
    }
    
    async init() {
        await this.loadData();
        this.setupListeners();
        this.setupAlarms();
        this.updateBadge();
        console.log('Cai Lo Detox initialized');
    }
    
    async loadData() {
        try {
            const data = await chrome.storage.local.get([
                'blockedDomains', 
                'isEnabled', 
                'detoxData',
                'selectedMode',
                'blockedCounts'
            ]);
            
            this.blockedDomains = data.blockedDomains || [];
            this.isEnabled = data.isEnabled !== undefined ? data.isEnabled : true;
            this.detoxData = data.detoxData || {};
            this.selectedMode = data.selectedMode || 'detox';
            this.blockedCounts = data.blockedCounts || {};
            
            // Reset daily times if needed
            await this.resetDailyTimes();
        } catch (error) {
            console.error('Error loading background data:', error);
        }
    }
    
    async saveData() {
        try {
            await chrome.storage.local.set({
                blockedDomains: this.blockedDomains,
                isEnabled: this.isEnabled,
                detoxData: this.detoxData,
                selectedMode: this.selectedMode,
                blockedCounts: this.blockedCounts
            });
        } catch (error) {
            console.error('Error saving background data:', error);
        }
    }
    
    // Setup alarms for daily reset
    setupAlarms() {
        // Create alarm for daily reset at midnight
        chrome.alarms.create('dailyReset', {
            periodInMinutes: 60 * 24, // 24 hours
            when: this.getNextMidnight()
        });
        
        // Create alarm for periodic time tracking
        chrome.alarms.create('timeTracking', {
            periodInMinutes: 1 // Check every minute
        });
        
        // Listen for alarms
        chrome.alarms.onAlarm.addListener((alarm) => {
            if (alarm.name === 'dailyReset') {
                this.handleDailyReset();
            } else if (alarm.name === 'timeTracking') {
                this.handleTimeTracking();
            }
        });
    }
    
    getNextMidnight() {
        const now = new Date();
        const midnight = new Date();
        midnight.setHours(24, 0, 0, 0);
        return midnight.getTime();
    }
    
    async handleDailyReset() {
        console.log('Performing daily reset...');
        await this.resetDailyTimes();
        
        // Notify popup
        chrome.runtime.sendMessage({
            type: 'DETOX_RESET_NOTIFICATION',
            count: Object.keys(this.detoxData).length
        });
        
        this.updateBadge();
    }
    
    async resetDailyTimes() {
        const today = new Date().toDateString();
        let updated = false;
        
        for (const domain in this.detoxData) {
            const data = this.detoxData[domain];
            const lastResetDate = new Date(data.lastReset).toDateString();
            
            if (lastResetDate !== today) {
                // Calculate day number
                const daysSinceStart = Math.floor((Date.now() - data.startDate) / (1000 * 60 * 60 * 24));
                const newDailyLimit = Math.max(5, 60 - (daysSinceStart * 10)); // Start 60min, decrease 10min/day
                
                this.detoxData[domain] = {
                    ...data,
                    dailyLimit: newDailyLimit,
                    remainingTime: newDailyLimit,
                    lastReset: Date.now(),
                    usedTimeToday: 0
                };
                
                updated = true;
                
                console.log(`Reset ${domain}: Day ${daysSinceStart + 1}, Limit: ${newDailyLimit}min`);
            }
        }
        
        if (updated) {
            await this.saveData();
        }
    }
    
    handleTimeTracking() {
        // Track active tab time
        chrome.tabs.query({active: true, currentWindow: true}, (tabs) => {
            if (tabs.length > 0) {
                const tab = tabs[0];
                this.trackTabActivity(tab.id, tab.url);
            }
        });
        
        // Check for time limit exceeded
        this.checkTimeLimits();
    }
    
    trackTabActivity(tabId, url) {
        if (!url || url.startsWith('chrome://') || url.startsWith('edge://')) {
            return;
        }
        
        const domain = this.extractDomain(url);
        
        // Check if domain is in detox mode
        if (this.detoxData[domain]) {
            const now = Date.now();
            
            // Initialize or update timer
            if (!this.activeTimers[tabId] || this.activeTimers[tabId].domain !== domain) {
                // Record previous domain time if any
                if (this.activeTimers[tabId]) {
                    this.recordTabTime(this.activeTimers[tabId]);
                }
                
                // Start new timer
                this.activeTimers[tabId] = {
                    domain: domain,
                    startTime: now,
                    url: url
                };
                
                // Send time update to content script
                this.sendTimeUpdate(tabId, domain);
            } else {
                // Update existing timer
                const elapsed = (now - this.activeTimers[tabId].startTime) / 1000; // seconds
                
                // Record time every 30 seconds
                if (elapsed >= 30) {
                    this.recordTabTime(this.activeTimers[tabId]);
                    this.activeTimers[tabId].startTime = now;
                    
                    // Update content script
                    this.sendTimeUpdate(tabId, domain);
                }
            }
        } else if (this.activeTimers[tabId]) {
            // Domain not in detox, clear timer
            this.recordTabTime(this.activeTimers[tabId]);
            delete this.activeTimers[tabId];
        }
    }
    
    recordTabTime(timer) {
        if (!timer.startTime) return;
        
        const elapsedMinutes = (Date.now() - timer.startTime) / (1000 * 60);
        
        if (elapsedMinutes > 0 && this.detoxData[timer.domain]) {
            // Record time usage
            this.detoxData[timer.domain].usedTimeToday += elapsedMinutes;
            this.detoxData[timer.domain].remainingTime = Math.max(
                0, 
                this.detoxData[timer.domain].dailyLimit - this.detoxData[timer.domain].usedTimeToday
            );
            this.detoxData[timer.domain].totalUsedTime = 
                (this.detoxData[timer.domain].totalUsedTime || 0) + elapsedMinutes;
            this.detoxData[timer.domain].lastUpdate = Date.now();
            
            // Save data
            this.saveData();
            
            // Notify popup
            chrome.runtime.sendMessage({
                type: 'TIME_USAGE_UPDATE',
                domain: timer.domain,
                minutes: elapsedMinutes
            });
            
            console.log(`Recorded ${elapsedMinutes.toFixed(2)}min for ${timer.domain}`);
        }
    }
    
    sendTimeUpdate(tabId, domain) {
        if (!this.detoxData[domain]) return;
        
        const detox = this.detoxData[domain];
        
        chrome.tabs.sendMessage(tabId, {
            type: 'UPDATE_TIME_REMAINING',
            domain: domain,
            remainingTime: detox.remainingTime,
            dailyLimit: detox.dailyLimit,
            usedToday: detox.usedTimeToday
        }).catch(() => {
            // Content script might not be ready, ignore
        });
    }
    
    checkTimeLimits() {
        for (const domain in this.detoxData) {
            const detox = this.detoxData[domain];
            
            if (detox.remainingTime <= 0) {
                // Time limit exceeded, block the domain
                this.blockDomainCompletely(domain);
            }
        }
    }
    
    blockDomainCompletely(domain) {
        // Check all tabs and block those with this domain
        chrome.tabs.query({}, (tabs) => {
            tabs.forEach(tab => {
                if (tab.url && tab.url.includes(domain)) {
                    this.redirectToBlockPage(tab.id, domain, tab.url);
                }
            });
        });
        
        // Send notification
        this.showNotification(
            `⏰ ${domain}: ĐÃ HẾT THỜI GIAN`,
            `Bạn đã sử dụng hết ${this.detoxData[domain]?.dailyLimit} phút cho hôm nay`
        );
    }
    
    redirectToBlockPage(tabId, domain, originalUrl) {
        const blockPageUrl = chrome.runtime.getURL('blocked.html') + 
                            `?domain=${encodeURIComponent(domain)}&url=${encodeURIComponent(originalUrl)}&reason=timeout`;
        
        chrome.tabs.update(tabId, { url: blockPageUrl });
    }
    
    setupListeners() {
        // Message listener
        chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
            this.handleMessage(message, sender, sendResponse);
            return true;
        });
        
        // Tab activity listeners
        chrome.tabs.onActivated.addListener((activeInfo) => {
            this.handleTabActivated(activeInfo);
        });
        
        chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
            if (changeInfo.status === 'complete') {
                this.handleTabUpdated(tabId, tab);
            }
        });
        
        chrome.tabs.onRemoved.addListener((tabId) => {
            this.handleTabRemoved(tabId);
        });
        
        chrome.windows.onFocusChanged.addListener((windowId) => {
            if (windowId !== chrome.windows.WINDOW_ID_NONE) {
                this.handleWindowFocus(windowId);
            }
        });
        
        // Web navigation listener
        chrome.webNavigation.onBeforeNavigate.addListener((details) => {
            if (details.frameId === 0) {
                this.handleNavigation(details);
            }
        });
    }
    
    handleMessage(message, sender, sendResponse) {
        switch (message.type) {
            case 'UPDATE_BLOCKED_DOMAINS':
                this.blockedDomains = message.data.blockedDomains || [];
                this.isEnabled = message.data.isEnabled !== undefined ? message.data.isEnabled : true;
                this.detoxData = message.data.detoxData || {};
                this.selectedMode = message.data.selectedMode || 'detox';
                this.saveData();
                this.updateBadge();
                sendResponse({ success: true });
                break;
                
            case 'GET_BLOCKED_DOMAINS':
                sendResponse({
                    blockedDomains: this.blockedDomains,
                    isEnabled: this.isEnabled,
                    detoxData: this.detoxData
                });
                break;
                
            case 'CHECK_URL':
                const shouldBlock = this.shouldBlockUrl(message.url);
                sendResponse({ shouldBlock });
                break;
                
            case 'REPORT_BLOCKED':
                this.recordBlock(message.domain, message.url);
                sendResponse({ success: true });
                break;
                
            case 'TIME_LIMIT_EXCEEDED':
                this.blockDomainCompletely(message.domain);
                sendResponse({ success: true });
                break;
                
            case 'GET_DETOX_INFO':
                const info = this.detoxData[message.domain] ? {
                    remaining: this.detoxData[message.domain].remainingTime,
                    dailyLimit: this.detoxData[message.domain].dailyLimit,
                    usedToday: this.detoxData[message.domain].usedTimeToday
                } : null;
                sendResponse({ info });
                break;
                
            default:
                sendResponse({ error: 'Unknown message type' });
        }
    }
    
    handleTabActivated(activeInfo) {
        chrome.tabs.get(activeInfo.tabId, (tab) => {
            if (tab && tab.url) {
                this.trackTabActivity(tab.id, tab.url);
            }
        });
    }
    
    handleTabUpdated(tabId, tab) {
        if (tab && tab.url) {
            this.trackTabActivity(tabId, tab.url);
        }
    }
    
    handleTabRemoved(tabId) {
        if (this.activeTimers[tabId]) {
            this.recordTabTime(this.activeTimers[tabId]);
            delete this.activeTimers[tabId];
        }
    }
    
    handleWindowFocus(windowId) {
        chrome.tabs.query({active: true, windowId: windowId}, (tabs) => {
            if (tabs[0]) {
                this.trackTabActivity(tabs[0].id, tabs[0].url);
            }
        });
    }
    
    handleNavigation(details) {
        if (this.shouldBlockUrl(details.url)) {
            chrome.tabs.update(details.tabId, {
                url: chrome.runtime.getURL('blocked.html') + 
                     `?domain=${encodeURIComponent(this.extractDomain(details.url))}&url=${encodeURIComponent(details.url)}`
            });
        }
    }
    
    shouldBlockUrl(url) {
        if (!this.isEnabled) return false;
        
        try {
            const urlObj = new URL(url);
            const hostname = urlObj.hostname;
            
            // Check normal blocking
            const isBlocked = this.blockedDomains.some(domain => {
                return hostname === domain.name || hostname.endsWith('.' + domain.name);
            });
            
            if (!isBlocked) return false;
            
            // Check detox mode
            const domain = this.extractDomain(url);
            if (this.detoxData[domain]) {
                // Check if time limit exceeded
                return this.detoxData[domain].remainingTime <= 0;
            }
            
            return true;
        } catch (error) {
            return false;
        }
    }
    
    recordBlock(domain, url) {
        // Update blocked counts
        const today = new Date().toDateString();
        this.blockedCounts[today] = (this.blockedCounts[today] || 0) + 1;
        this.saveData();
    }
    
    extractDomain(url) {
        try {
            const urlObj = new URL(url);
            return urlObj.hostname;
        } catch (error) {
            return '';
        }
    }
    
    updateBadge() {
        if (!this.isEnabled) {
            chrome.action.setBadgeText({ text: 'OFF' });
            chrome.action.setBadgeBackgroundColor({ color: '#6B7280' });
            return;
        }
        
        const detoxCount = Object.keys(this.detoxData).length;
        const badgeText = detoxCount > 0 ? detoxCount.toString() : '';
        
        chrome.action.setBadgeText({ text: badgeText });
        chrome.action.setBadgeBackgroundColor({ color: '#FF6B6B' });
    }
    
    showNotification(title, message) {
        if (!chrome.notifications) return;
        
        chrome.notifications.create({
            type: 'basic',
            iconUrl: 'icons/icon128.png',
            title: title,
            message: message,
            priority: 2,
            buttons: [
                { title: 'Mở Cai Lọ' }
            ]
        });
        
        // Handle button click
        chrome.notifications.onButtonClicked.addListener((notificationId, buttonIndex) => {
            if (buttonIndex === 0) {
                chrome.action.openPopup();
            }
        });
    }
}

// Initialize background service
const backgroundService = new BackgroundService();

// Listen for installation
chrome.runtime.onInstalled.addListener((details) => {
    if (details.reason === 'install') {
        // First install
        chrome.tabs.create({ url: chrome.runtime.getURL('popup.html') });
    }
});