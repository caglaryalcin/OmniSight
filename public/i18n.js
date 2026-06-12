(function(){
  const ATTRS = ['placeholder','title','aria-label'];
  const locales = {
    en: {},
    tr: {
      'Dashboard':'Panel',
      'Settings':'Ayarlar',
      'Logs':'Kayıtlar',
      'Agents':'Ajanlar',
      'Profile':'Profil',
      'About':'Hakkında',
      'Help':'Yardım',
      'Sign out':'Çıkış yap',
      'Public status':'Durum Sayfası',
      'Status':'Durum',
      'Status page':'Durum Sayfası',
      'Status Page':'Durum Sayfası',
      'Public status page is enabled':'Durum Sayfası açık',
      'Open public status page':'Durum Sayfasını aç',
      'Live platforms':'Canlı platformlar',
      'Search host, service, container':'Host, servis, container ara',
      'Theme':'Tema',
      'Account':'Hesap',
      'Pause':'Duraklat',
      'Resume':'Sürdür',
      'Refresh':'Yenile',
      'All healthy':'Tümü sağlıklı',
      'degraded':'sorunlu',
      'healthy':'sağlıklı',
      'connecting...':'bağlanıyor...',
      'connecting…':'bağlanıyor…',
      'Unconfigured':'Yapılandırılmamış',
      'No data configured':'Veri yapılandırılmadı',
      'Loading…':'Yükleniyor…',
      'Loading logs...':'Kayıtlar yükleniyor...',
      'No rows to show yet':'Henüz satır yok',
      'No monitors found':'Monitör bulunamadı',
      'Uptime Kuma unreachable':'Uptime Kuma erişilemiyor',
      'Recent logs':'Son kayıtlar',
      'Active alerts':'Aktif bildirimler',
      'No active alerts':'Aktif bildirim yok',
      'CPU usage':'CPU kullanımı',
      'Memory usage':'Bellek kullanımı',
      'Disk I/O':'Disk I/O',
      'Bandwidth':'Bant genişliği',
      'Temperature':'Sıcaklık',
      'CPU temperature':'CPU sıcaklığı',
      'CPU temp':'CPU sıcaklığı',
      'System temperature':'Sistem sıcaklığı',
      'System temp':'Sistem sıcaklığı',
      'Disk temp':'Disk sıcaklığı',
      'Sort by':'Sıralama',
      'Name':'İsim',
      'NAME':'İSİM',
      'Memory':'Bellek',
      'RAM':'RAM',
      'Network':'Ağ',
      'Disk':'Disk',
      'Image':'İmaj',
      'Ports':'Portlar',
      'State':'Durum',
      'Network I/O':'Ağ I/O',
      'All platforms':'Tüm platformlar',
      'Network devices':'Ağ cihazları',
      'Linux Servers':'Linux Sunucuları',
      'Not reported':'Raporlanmadı',
      'Read and write combined':'Okuma ve yazma toplamı',
      'Inbound plus outbound':'Gelen ve giden toplamı',
      'Monitor':'Monitör',
      'Last Heartbeat':'Son heartbeat',
      'Ping':'Ping',
      'Total':'Toplam',
      'Up':'Up',
      'Down':'Down',
      'Pending':'Bekleyen',
      'Maint':'Bakım',
      'Unreachable':'Erişilemiyor',
      'Expand sidebar':'Sidebar genişlet',
      'Collapse sidebar':'Sidebar daralt',
      'Resize sidebar':'Sidebar boyutlandır',
      'Collapse':'Kapat',
      'Expand':'Aç',
      'Connected push agents and their installed versions.':'Bağlı push ajanları ve kurulu sürümleri.',
      'Latest':'Güncel',
      'Agent':'Ajan',
      'Role':'Rol',
      'System':'Sistem',
      'Version':'Sürüm',
      'Action':'İşlem',
      'Loading agents...':'Ajanlar yükleniyor...',
      'No agents have reported yet.':'Henüz raporlayan ajan yok.',
      'unknown':'bilinmiyor',
      'online':'çevrimiçi',
      'offline':'çevrimdışı',
      'Update':'Güncelle',
      'Offline':'Çevrimdışı',
      'Current':'Güncel',
      'Updating...':'Güncelleniyor...',
      'Copied':'Kopyalandı',
      'Copy':'Kopyala',
      'Manual update required.':'Manuel güncelleme gerekli.',
      'Update command sent. Waiting for next report...':'Güncelleme komutu gönderildi. Sonraki rapor bekleniyor...',
      'never':'hiç',
      'ago':'önce',
      'Follow':'Takip et',
      'Clear':'Temizle',
      'Copy all':'Tümünü kopyala',
      'Copy failed':'Kopyalanamadı',
      'Filter…':'Filtrele…',
      'No logs yet…':'Henüz kayıt yok…',
      'No matching logs':'Eşleşen kayıt yok',
      'entries':'kayıt',
      'System Settings':'Sistem Ayarları',
      'Appearance':'Görünüm',
      'Timezone':'Saat dilimi',
      'Time Format':'Saat formatı',
      'Default time period':'Varsayılan zaman aralığı',
      'Preferred language':'Tercih edilen dil',
      'Dashboard side panel':'Dashboard sağ paneli',
      'Show Active alerts and Recent logs':'Aktif bildirimler ve son kayıtları göster',
      'English':'İngilizce',
      'Turkish':'Türkçe',
      '🇬🇧 English':'🇬🇧 İngilizce',
      '🇹🇷 Turkish':'🇹🇷 Türkçe',
      'Certificates':'Sertifikalar',
      'CA certificates':'CA sertifikaları',
      'Upload certificate':'Sertifika yükle',
      'Public status page':'Herkese açık durum sayfası',
      'Read-only summary at':'Salt okunur özet',
      'no login required':'Oturum açmaya gerek yok',
      'Read-only summary at /status, no login required':'/status adresinde salt okunur özet, oturum açmaya gerek yok',
      'Public page title':'Herkese açık sayfa başlığı',
      'Resource thresholds':'Kaynak eşikleri',
      'Alerts':'Bildirimler',
      'CPU Warning %':'CPU Uyarı %',
      'RAM Warning %':'RAM Uyarı %',
      'Disk Warning %':'Disk Uyarı %',
      'CPU Critical %':'CPU Kritik %',
      'RAM Critical %':'RAM Kritik %',
      'Disk Critical %':'Disk Kritik %',
      'History range (default)':'Geçmiş aralığı (varsayılan)',
      'History range':'Geçmiş aralığı',
      'Username (optional)':'Kullanıcı adı (opsiyonel)',
      'Password (optional)':'Parola (opsiyonel)',
      'API Key (optional)':'API anahtarı (opsiyonel)',
      'Status page slug':'Durum sayfası slug',
      'URL':'URL',
      'TLS':'TLS',
      'Verify certificate':'Sertifikayı doğrula',
      'Allow self-signed':'Self-signed kabul et',
      'Last 20 minutes':'Son 20 dakika',
      'Last 1 hour':'Son 1 saat',
      'Last 3 hours':'Son 3 saat',
      'Last 6 hours':'Son 6 saat',
      'Last 12 hours':'Son 12 saat',
      'Last 24 hours':'Son 24 saat',
      'Save & Apply':'Kaydet ve uygula',
      'Browse…':'Göz at…',
      'Icon (optional)':'İkon (opsiyonel)',
      'API URL':'API URL',
      'Token ID':'Token ID',
      'Token Secret':'Token Secret',
      'API TLS':'API TLS',
      'SSH metrics fallback':'SSH metrik yedeği',
      '+ Add SSH':'+ SSH ekle',
      'Add one SSH entry for each Proxmox node. Node name must match the Proxmox node name. SSH host is the node IP or DNS. Save & Apply; Disk I/O appears after the second refresh.':'Her Proxmox node için bir SSH satırı ekle. Node adı Proxmox node adıyla aynı olmalı. SSH host node IP veya DNS adresidir. Kaydet ve uygula; Disk I/O ikinci yenilemeden sonra görünür.',
      'Node name':'Node adı',
      'Proxmox node name':'Proxmox node adı',
      'Node IP or DNS':'Node IP veya DNS',
      'SSH host':'SSH host',
      'SSH user':'SSH kullanıcısı',
      'SSH port':'SSH port',
      'Command':'Komut',
      'No sudo':'Sudo yok',
      'Use sudo':'Sudo kullan',
      'SSH key path (optional)':'SSH key path (opsiyonel)',
      'SSH password (optional)':'SSH parolası (opsiyonel)',
      'Leave blank to keep current password':'Mevcut parolayı korumak için boş bırak',
      'Proxmox SSH metrics':'Proxmox SSH metrikleri',
      'Host time: loading...':'Host saati: yükleniyor...',
      'No certificates uploaded.':'Yüklenmiş sertifika yok.',
      'Could not load certificates.':'Sertifikalar yüklenemedi.',
      'SYSTEMS':'SUNUCULAR',
      'Systems':'Sunucular',
      'Operational':'Çalışıyor',
      'Degraded':'Sorunlu',
      'Connecting…':'Bağlanıyor…',
      'Unknown':'Bilinmiyor',
      'Last updated':'Son güncelleme',
      'All systems operational':'Tüm sunucular çalışıyor',
      'Partial degradation':'Kısmi sorun var',
      'Major outage':'Büyük kesinti',
      'No data':'Veri yok',
      'No services configured':'Yapılandırılmış servis yok',
      'Status page is not enabled':'Durum sayfası etkin değil',
      'Auto-refreshes every 15s':'Her 15 saniyede otomatik yenilenir',
      'Powered by OmniSight':'OmniSight ile çalışır',
      'version':'sürüm',
      'by':'yazar',
      'Author:':'Yazar:'
    }
  };

  function currentLang(fallback = 'en'){
    try { return localStorage.getItem('os_lang') || fallback || 'en'; }
    catch { return fallback || 'en'; }
  }
  function setLang(lang){
    const next = locales[lang] ? lang : 'en';
    try { localStorage.setItem('os_lang', next); } catch {}
    if (document?.documentElement) document.documentElement.lang = next;
    return next;
  }
  function t(text, lang = currentLang()){
    return locales[lang]?.[text] || text;
  }
  function apply(root = document, lang = currentLang()){
    lang = setLang(lang);
    const doc = root.nodeType === 9 ? root : root.ownerDocument || document;
    if (doc.documentElement) doc.documentElement.lang = lang;
    root.querySelectorAll?.('*').forEach(el => ATTRS.forEach(attr => {
      if (!el.hasAttribute(attr)) return;
      const key = `_osOrig_${attr}`;
      if (el[key] === undefined) el[key] = el.getAttribute(attr);
      el.setAttribute(attr, t(el[key], lang));
    }));
    const walker = doc.createTreeWalker(root.body || root, NodeFilter.SHOW_TEXT, {
      acceptNode(node){
        const p = node.parentElement;
        if (!p || ['SCRIPT','STYLE','PRE','CODE','TEXTAREA'].includes(p.tagName)) return NodeFilter.FILTER_REJECT;
        return node.nodeValue.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      }
    });
    let node;
    while ((node = walker.nextNode())) {
      if (node._osOrigText === undefined) node._osOrigText = node.nodeValue;
      const original = node._osOrigText;
      const trimmed = original.trim();
      node.nodeValue = original.replace(trimmed, t(trimmed, lang));
    }
    return lang;
  }
  function register(lang, dict){
    locales[lang] = { ...(locales[lang] || {}), ...(dict || {}) };
  }
  function dict(lang){ return locales[lang] || {}; }

  window.OmniI18n = { ATTRS, locales, dict, currentLang, setLang, t, apply, register };
})();
