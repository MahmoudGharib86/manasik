const $ = id => document.getElementById(id);
const cfg = window.MANASIK_CONFIG;
const match = location.pathname.match(/^\/manasik\/k\/([A-Za-z2-9]{6,12})\/?$/);
let client, user, khatma, parts=[], active, page, book, bundles=new Map(), blobUrl, textMode=true, claimJuz, busy=false;
let saving=Promise.resolve(), renderGeneration=0, refreshGeneration=0, liveChannel, liveRefreshTimer;
const storage = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key,value) { try { localStorage.setItem(key,String(value)); return true; } catch { return false; } },
};
const code=match?.[1].toUpperCase();
function offerInstalledApp() {
  if(!code || !/Android/i.test(navigator.userAgent) || new URLSearchParams(location.search).has('web')) return;
  // Android keeps this page open when no application handles the private scheme.
  // The visible button remains available when a browser blocks automatic launch.
  const target='manasik://khatma/'+code;
  setTimeout(()=>{ if(!document.hidden) location.href=target; },350);
}
function confirmAction(message) {
  return new Promise(resolve=>{
    const dialog=$('confirm-dialog');dialog.returnValue='no';
    $('confirm-message').textContent=message;
    dialog.addEventListener('close',()=>resolve(dialog.returnValue==='yes'),{once:true});
    dialog.showModal();
  });
}
const message=e => /rate|429/i.test(String(e?.message||e)) ? 'طلبات كثيرة؛ انتظر قليلًا ثم أعد المحاولة.' :
  /closed/i.test(String(e?.message||e)) ? 'الختمة مغلقة حاليًا.' :
  /part_not_available/i.test(String(e?.message||e)) ? 'سبق مشارك آخر إلى حجز هذا الجزء. حدّث القائمة.' : 'تعذر الاتصال أو إتمام الطلب. أعد المحاولة؛ لم يتم تأكيد التغيير.';
async function result(request) { const r=await request; if(r.error) throw r.error; return r.data; }
const rpc=(name,params)=>result(client.rpc(name,params));
const params=juz=>({p_khatma_id:khatma.id,p_juz:juz});
function stats(done,claimed,available) {
  $('stats').replaceChildren();
  for(const [n,label] of [[done,'مقروء'],[claimed,'جاري القراءة'],[available,'متاح']]) {
    const cell=document.createElement('div'); cell.className='stat';
    const number=document.createElement('div');number.className='number';number.textContent=n;
    cell.append(number,document.createTextNode(label));$('stats').append(cell);
  }
  $('stats').hidden=false;$('completion').value=done;
}
function heading(k) {
  $('title').textContent=k.kind==='deceased' ? 'ختمة عن روح '+(k.gender==='female'?'المرحومة ':'المرحوم ')+(k.deceased_name||'') : 'ختمة قرآن مشتركة';
}
async function start() {
  $('retry').hidden=true;
  if(!code || !cfg?.supabaseUrl || !window.supabase) { $('status').textContent='رابط غير صالح أو تعذر تحميل الخدمة.'; return; }
  client ??= window.supabase.createClient(cfg.supabaseUrl,cfg.publishableKey,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:false},global:{fetch:(url,init={})=>fetch(url,{...init,signal:AbortSignal.any([...(init.signal?[init.signal]:[]),AbortSignal.timeout(15000)])})}});
  $('open-app').href='manasik://khatma/'+code;$('open-app').hidden=false;
  try {
    const rows=await rpc('public_khatma_summary',{p_code:code}), summary=rows?.[0];
    if(!summary) { $('status').textContent='لم نعثر على ختمة بهذا الرمز.';return; }
    heading(summary);stats(summary.completed_count,summary.claimed_count,summary.available_count);
    $('status').textContent=summary.is_closed?'الختمة مغلقة.':'شارك القراءة من هنا، دون تنزيل التطبيق.';
    const session=await client.auth.getSession(); if(session.error) throw session.error;
    user=session.data.session?.user;
    if(user) {
      const existing=await result(client.from('khatmas').select('*').eq('code',code).maybeSingle());
      if(existing) { khatma=existing;await refresh();return; }
    }
    $('join').hidden=summary.is_closed;
  } catch(e) { $('status').textContent=message(e);$('retry').hidden=false; }
}
async function join() {
  if(busy)return;busy=true;$('join').disabled=true;
  try {
    if(!user) { const auth=await client.auth.signInAnonymously();if(auth.error)throw auth.error;user=auth.data.user; }
    const rows=await rpc('join_khatma',{p_code:code});
    if(!rows?.[0])throw Error('closed');khatma=rows[0];await refresh();
  } catch(e) {$('status').textContent=message(e);} finally {busy=false;$('join').disabled=false;}
}
async function refresh() {
  if(!khatma)return;const generation=++refreshGeneration;
  const [nextParts, latest]=await Promise.all([
    result(client.from('khatma_parts').select('*').eq('khatma_id',khatma.id).order('juz',{ascending:true})),
    result(client.from('khatmas').select('*').eq('id',khatma.id).single()),
  ]);
  if(generation!==refreshGeneration)return;
  nextParts.sort((a,b)=>a.juz-b.juz);
  if(JSON.stringify(nextParts)===JSON.stringify(parts)&&latest.is_closed===khatma.is_closed){ensureRealtime();$('live-status').textContent='متصل · التحديث اللحظي مفعّل.';return;}
  parts=nextParts;khatma=latest;heading(khatma);
  renderMemorial();
  stats(parts.filter(p=>p.status==='completed').length,parts.filter(p=>p.status==='claimed').length,parts.filter(p=>p.status==='available').length);
  $('join').hidden=true;$('participation').hidden=false;
  $('status').textContent=khatma.is_closed?'الختمة مغلقة للحجوزات الجديدة.':'أنت مشارك في الختمة. اختر جزءك وابدأ القراءة.';
  $('owner-actions').hidden=khatma.created_by!==user.id;
  $('close-khatma').textContent=khatma.is_closed?'إعادة فتح الختمة':'إغلاق الحجوزات الجديدة';
  $('parts').replaceChildren();
  for(const p of parts) {
    const mine=p.claimed_by===user.id, button=document.createElement('button');button.className=`part ${p.status}${mine?' mine':''}`;
    const title=document.createElement('strong');title.textContent='الجزء '+p.juz;
    const name=document.createElement('span');name.textContent=p.status==='available'?'متاح':p.claimed_name||'قارئ مشارك';
    const state=document.createElement('small');state.textContent=p.status==='completed'?'تمت القراءة ✓':p.status==='claimed'?(mine?'جزؤك · استكمال القراءة':'قيد القراءة'):'احجز وابدأ';
    button.append(title,name,state);button.addEventListener('click',()=>selectPart(p));$('parts').append(button);
  }
  ensureRealtime();
  $('live-status').textContent='متصل · التحديث اللحظي مفعّل.';
}
function scheduleLiveRefresh() {
  clearTimeout(liveRefreshTimer);
  liveRefreshTimer=setTimeout(()=>{
    if(khatma&&!busy&&!active&&!$('claim-dialog').open) refresh().catch(()=>$('live-status').textContent='انقطع التحديث اللحظي مؤقتًا؛ ستتم إعادة المحاولة تلقائيًا.');
  },120);
}
function ensureRealtime() {
  if(!client||!khatma||liveChannel)return;
  liveChannel=client.channel('shared-khatma-'+khatma.id)
    .on('postgres_changes',{event:'*',schema:'public',table:'khatma_parts',filter:'khatma_id=eq.'+khatma.id},scheduleLiveRefresh)
    .on('postgres_changes',{event:'UPDATE',schema:'public',table:'khatmas',filter:'id=eq.'+khatma.id},scheduleLiveRefresh)
    .subscribe(status=>{
      if(status==='SUBSCRIBED') $('live-status').textContent='متصل · التحديث اللحظي مفعّل.';
      else if(status==='CHANNEL_ERROR'||status==='TIMED_OUT') $('live-status').textContent='التحديث اللحظي متوقف مؤقتًا؛ يعمل التحديث الاحتياطي.';
    });
}
function selectPart(p) {
  if(p.status==='available') {
    if(khatma.is_closed){$('live-status').textContent='الختمة مغلقة للحجز.';return;}
    claimJuz=p.juz;$('claim-number').textContent=p.juz;$('reader-name').value=storage.get('manasik-reader-name')||'';$('claim-error').textContent='';$('claim-dialog').showModal();
  } else if(p.claimed_by===user.id || p.status==='completed') { openReader(p); }
  else {$('live-status').textContent=`الجزء محجوز للقارئ ${p.claimed_name||'المشارك'}. اختر جزءًا متاحًا.`;}
}
async function claim(event) {
  event.preventDefault();if(busy)return;
  const name=$('reader-name').value.trim();if(name.length<2){$('claim-error').textContent='اكتب اسمًا من حرفين على الأقل.';return;}
  busy=true;const submit=$('claim-form').querySelector('[type=submit]');submit.disabled=true;
  try {const rows=await rpc('claim_khatma_part',{...params(claimJuz),p_name:name});storage.set('manasik-reader-name',name);$('claim-dialog').close();await openReader(rows[0]);}
  catch(e){$('claim-error').textContent=message(e);}finally{busy=false;submit.disabled=false;}
}
async function loadBook() {
  if(book)return book;
  const res=await fetch('/manasik/shared-quran.json',{signal:AbortSignal.timeout(20000)});if(!res.ok)throw Error('book unavailable');
  book=await res.json();return book;
}
const progressKey=p=>`manasik-page-${khatma.id}-${p.juz}-${p.claimed_by}-${p.claimed_at}`;
async function openReader(p) {
  active=p;$('hub').hidden=true;$('reader').hidden=false;$('reader-status').textContent='جارٍ تجهيز صفحات الجزء…';
  $('previous').disabled=true;$('next').disabled=true;
  $('page-image').hidden=true;$('page-text').hidden=true;$('reader-title').textContent='الجزء '+p.juz;
  const mine=p.claimed_by===user.id&&p.status==='claimed';$('complete').hidden=!mine;$('release').hidden=!mine;
  try {await loadBook();if(active!==p)return;const bounds=book.parts[p.juz-1];
    const local=Number(storage.get(progressKey(p))), remote=p.last_read_page;
    page=Math.max(bounds.first,Math.min(bounds.last,local||remote||bounds.first));
    history.pushState({reading:true},'');await showPage();
  } catch(e){$('reader-status').textContent='تعذر تحميل صفحات المصحف. ارجع للختمة وأعد فتح الجزء.';}
}
async function loadBundle(juz) {
  if(bundles.has(juz))return bundles.get(juz);
  const entry=book.parts[juz-1],r=await fetch('/manasik/'+entry.file,{signal:AbortSignal.timeout(45000)});if(!r.ok)throw Error('pages unavailable');
  const bytes=await r.arrayBuffer();
  const digest=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(n=>n.toString(16).padStart(2,'0')).join('');
  if(digest!==entry.sha256)throw Error('Invalid page checksum');
  const text=await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
  const data=JSON.parse(text);bundles.clear();bundles.set(juz,data);return data;
}
async function showPage() {
  const generation=++renderGeneration,p=active;if(!p)return;
  const bounds=book.parts[p.juz-1];$('previous').disabled=page<=bounds.first;$('next').disabled=page>=bounds.last;
  $('page-number').textContent='صفحة '+page+' · '+bounds.first+'–'+bounds.last;
  $('page-image').hidden=true;$('page-text').hidden=true;$('reader-status').textContent='جارٍ تحميل الصفحة…';
  if(textMode) {renderText();$('reader-status').textContent='';return;}
  try {const bundle=await loadBundle(p.juz);if(generation!==renderGeneration||active!==p)return;
    if(!bundle[page])throw Error('missing page');
    if(blobUrl)URL.revokeObjectURL(blobUrl);blobUrl=URL.createObjectURL(new Blob([bundle[page]],{type:'image/svg+xml'}));
    $('page-image').src=blobUrl;$('page-image').alt='صفحة '+page+' من المصحف';$('page-image').hidden=false;$('reader-status').textContent='';
  }catch(e){if(generation!==renderGeneration)return;renderText();$('reader-status').textContent='تعذر تحميل صورة الصفحة. النص القرآني محفوظ أدناه؛ اضغط «عرض المصحف» لإعادة المحاولة.';$('text-mode').textContent='عرض المصحف';textMode=true;}
}
function renderText() {
  const container=$('page-text');container.replaceChildren();container.hidden=false;
  container.classList.toggle('opening-page',page<=2);
  const verses=book.verses.filter(v=>v.page===page);
  const first=verses[0];
  const surahLabel=document.createElement('div');surahLabel.className='frame-label frame-surah';surahLabel.textContent=first?surahTitle(first.name):'';
  const juzLabel=document.createElement('div');juzLabel.className='frame-label frame-juz';juzLabel.textContent=juzTitle(first?.juz||active?.juz||1);
  const pageLabel=document.createElement('div');pageLabel.className='frame-label frame-page';pageLabel.textContent=String(page).replace(/[0-9]/g,d=>'٠١٢٣٤٥٦٧٨٩'[d]);
  const body=document.createElement('div');body.className='quran-body';
  container.append(surahLabel,juzLabel,pageLabel,body);
  let surah=0;
  for(const v of verses) {
    if(v.surah!==surah){const h=document.createElement('h3');h.textContent=surahTitle(v.name);body.append(h);surah=v.surah;}
    const span=document.createElement('span');span.textContent=v.text+' ﴿'+arabicDigits(v.ayah)+'﴾ ';body.append(span);
  }
  fitQuranPage(body,page<=2);
}
const juzOrdinals=['الأول','الثاني','الثالث','الرابع','الخامس','السادس','السابع','الثامن','التاسع','العاشر','الحادي عشر','الثاني عشر','الثالث عشر','الرابع عشر','الخامس عشر','السادس عشر','السابع عشر','الثامن عشر','التاسع عشر','العشرون','الحادي والعشرون','الثاني والعشرون','الثالث والعشرون','الرابع والعشرون','الخامس والعشرون','السادس والعشرون','السابع والعشرون','الثامن والعشرون','التاسع والعشرون','الثلاثون'];
function arabicDigits(value){return String(value).replace(/[0-9]/g,d=>'٠١٢٣٤٥٦٧٨٩'[d]);}
function surahTitle(name){const value=String(name||'').trim(),plain=value.replace(/[\u0610-\u061a\u064b-\u065f\u0670\u06d6-\u06ed]/g,'');return plain.startsWith('سورة')?value:'سورة '+value;}
function juzTitle(value){const n=Math.max(1,Math.min(30,Number(value)||1));return 'الجزء '+juzOrdinals[n-1];}
async function fitQuranPage(body,opening) {
  try{await document.fonts.ready;}catch(_){}
  requestAnimationFrame(()=>{
    let size=opening?34:31,minimum=opening?20:15;
    body.style.fontSize=size+'px';
    while(size>minimum&&(body.scrollHeight>body.clientHeight+1||body.scrollWidth>body.clientWidth+1)){
      size-=.5;body.style.fontSize=size+'px';
    }
  });
}
function savePage() {
  const p=active, n=page;if(!p||p.claimed_by!==user.id||p.status!=='claimed')return;
  const localSaved=storage.set(progressKey(p),n),args={...params(p.juz),p_page:n};
  saving=saving.then(async()=>{
    try{await rpc('save_khatma_reading_page',args);p.last_read_page=n;if(active===p){$('sync-page').hidden=true;}}
    catch(e){if(active===p){$('reader-status').textContent=localSaved?'حُفظ موضعك على هذا المتصفح؛ تعذرت المزامنة.':'تعذر حفظ الموضع؛ أعد المحاولة.';$('sync-page').hidden=false;}}
  });
}
function leaveReader() {renderGeneration++;active=null;$('reader').hidden=true;$('hub').hidden=false;$('sync-page').hidden=true;if(blobUrl){URL.revokeObjectURL(blobUrl);blobUrl=null;}refresh().catch(e=>$('live-status').textContent=message(e));}
async function finish(release=false) {
  if(busy||!active)return;
  if(!await confirmAction(release?'إلغاء حجز الجزء وإتاحته للآخرين؟':'هل أتممت قراءة هذا الجزء كاملًا؟'))return;
  busy=true;$('complete').disabled=true;$('release').disabled=true;
  try {await saving;await rpc(release?'release_khatma_part':'complete_khatma_part',params(active.juz));if(release)storage.set(progressKey(active),'');history.back();}
  catch(e){$('reader-status').textContent=message(e);}finally{busy=false;$('complete').disabled=false;$('release').disabled=false;}
}
$('join').onclick=join;$('retry').onclick=start;
$('refresh').onclick=()=>refresh().catch(e=>$('live-status').textContent=message(e));
$('claim-form').onsubmit=claim;$('cancel-claim').onclick=()=>$('claim-dialog').close();
$('reader-back').onclick=()=>history.state?.reading?history.back():leaveReader();
window.addEventListener('popstate',()=>{if(active)leaveReader();});
$('previous').onclick=()=>{page--;showPage();savePage();};$('next').onclick=()=>{page++;showPage();savePage();};
$('text-mode').onclick=()=>{textMode=!textMode;$('text-mode').textContent=textMode?'عرض المصحف':'قراءة نصية';showPage();};
$('sync-page').onclick=savePage;$('complete').onclick=()=>finish();$('release').onclick=()=>finish(true);
$('close-khatma').onclick=async()=>{if(busy||!await confirmAction(khatma.is_closed?'إعادة فتح الحجوزات؟':'إغلاق الحجوزات الجديدة؟'))return;busy=true;try{await rpc('set_khatma_closed',{p_khatma_id:khatma.id,p_closed:!khatma.is_closed});await refresh();}catch(e){$('live-status').textContent=message(e);}finally{busy=false;}};
// Realtime is primary; this slower poll recovers after tab suspension or a websocket interruption.
setInterval(()=>{if(khatma&&!document.hidden&&!busy&&!active&&!$('claim-dialog').open)refresh().catch(()=>$('live-status').textContent='تعذر التحديث التلقائي. تحقق من الاتصال واضغط تحديث.');},30000);
window.addEventListener('online',()=>{if(active)savePage();else if(khatma)refresh().catch(()=>{});});

// These use the same member-only records and allowed action kinds as the app.
let memorialSection, memorialDialog, memorialKind, dhikrCount=0;
const memorialLabels={dua:'دعاء',fatiha:'الفاتحة',yasin:'يس',waqiah:'الواقعة',tasbih:'تسبيح'};
function renderMemorial(){
  if(khatma.kind!=='deceased')return;
  if(!memorialSection){
    memorialSection=document.createElement('section');memorialSection.className='card';
    const title=document.createElement('h2');title.textContent='الدعاء والقراءة';
    const note=document.createElement('p');note.textContent='اختصارات للقراءة والدعاء. لا ينسب مناسك فضلًا مخصوصًا لسورة بعينها للمتوفى إلا بدليل موثق.';
    const buttons=document.createElement('div');buttons.className='reader-actions';
    for(const [kind,label] of Object.entries(memorialLabels)){
      const button=document.createElement('button');button.textContent=label;
      button.onclick=()=>openMemorial(kind);buttons.append(button);
    }
    const totals=document.createElement('p');totals.id='memorial-totals';totals.setAttribute('aria-live','polite');
    memorialSection.append(title,note,buttons,totals);$('participation').append(memorialSection);
    memorialDialog=document.createElement('dialog');memorialDialog.className='memorial-dialog';
    const heading=document.createElement('h2');heading.id='memorial-title';
    const text=document.createElement('div');text.id='memorial-text';text.className='memorial-text';
    const count=document.createElement('button');count.id='dhikr-count';count.onclick=()=>{dhikrCount++;count.textContent='سبحان الله · '+dhikrCount;};
    const status=document.createElement('p');status.id='memorial-status';status.setAttribute('role','status');
    const actions=document.createElement('div');actions.className='reader-actions';
    const save=document.createElement('button');save.id='memorial-save';save.onclick=saveMemorial;
    const close=document.createElement('button');close.textContent='رجوع للختمة';close.className='secondary';close.onclick=()=>memorialDialog.close();
    actions.append(save,close);memorialDialog.append(heading,text,count,status,actions);document.body.append(memorialDialog);
  }
  refreshMemorial().catch(()=>$('memorial-totals').textContent='تعذر تحديث إحصائيات الدعاء والقراءة.');
}
async function refreshMemorial(){
  const rows=await result(client.from('khatma_actions').select('kind,count').eq('khatma_id',khatma.id));
  const totals={};for(const row of rows)totals[row.kind]=(totals[row.kind]||0)+row.count;
  $('memorial-totals').textContent=Object.entries(memorialLabels).map(([k,v])=>v+': '+(totals[k]||0)).join(' · ');
}
async function openMemorial(kind){
  memorialKind=kind;dhikrCount=0;$('memorial-title').textContent=memorialLabels[kind];
  $('memorial-text').replaceChildren();$('memorial-status').textContent='';
  $('dhikr-count').hidden=kind!=='tasbih';$('dhikr-count').textContent='سبحان الله · 0';
  $('memorial-save').disabled=false;$('memorial-save').textContent=kind==='tasbih'?'تسجيل التسبيح':kind==='dua'?'أتممت الدعاء':'أتممت القراءة';
  memorialDialog.showModal();
  if(kind==='dua'){
    $('memorial-text').textContent=khatma.gender==='female'
      ? 'اللهم اغفر لها وارحمها، وعافها واعف عنها، وأكرم نزلها، ووسع مدخلها، واغسلها بالماء والثلج والبرد، ونقها من الخطايا كما نقيت الثوب الأبيض من الدنس، وأبدلها دارًا خيرًا من دارها، وأهلًا خيرًا من أهلها، وزوجًا خيرًا من زوجها، وأدخلها الجنة، وأعذها من عذاب القبر أو من عذاب النار.'
      : 'اللهم اغفر له وارحمه، وعافه واعف عنه، وأكرم نزله، ووسع مدخله، واغسله بالماء والثلج والبرد، ونقه من الخطايا كما نقيت الثوب الأبيض من الدنس، وأبدله دارًا خيرًا من داره، وأهلًا خيرًا من أهله، وزوجًا خيرًا من زوجه، وأدخله الجنة، وأعذه من عذاب القبر أو من عذاب النار.';
  }else if(kind!=='tasbih'){
    $('memorial-save').disabled=true;$('memorial-status').textContent='جارٍ تحميل السورة…';
    try{await loadBook();if(memorialKind!==kind||!memorialDialog.open)return;
      const surah={fatiha:1,yasin:36,waqiah:56}[kind];
      $('memorial-text').textContent=book.verses.filter(v=>v.surah===surah).map(v=>v.text+' ﴿'+v.ayah+'﴾').join(' ');
      $('memorial-status').textContent='';$('memorial-save').disabled=false;
    }catch(e){$('memorial-status').textContent='تعذر تحميل السورة. ارجع وأعد المحاولة.';}
  }
}
async function saveMemorial(){
  if(busy)return;const count=memorialKind==='tasbih'?dhikrCount:1;
  if(!count){$('memorial-status').textContent='اضغط زر التسبيح أولًا.';return;}
  busy=true;$('memorial-save').disabled=true;
  try{await result(client.from('khatma_actions').insert({khatma_id:khatma.id,user_id:user.id,kind:memorialKind,count:Math.min(count,10000)}));
    memorialDialog.close();await refreshMemorial();$('live-status').textContent='تم تسجيل مشاركتك.';
  }catch(e){$('memorial-status').textContent=message(e);}finally{busy=false;$('memorial-save').disabled=false;}
}
offerInstalledApp();
start();
