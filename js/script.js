// ======================= 全局状态 =======================
let RAW_ROWS = [];
let HEADERS = [];
let DATA = {id:[], label:[], score:[]};
let ROC = {fpr:[], tpr:[], th:[], points:[]};
let PRC = {recall:[], precision:[], th:[], points:[]};
let P = 0, N = 0;

// ======================= 工具函数 =======================
const $ = (sel)=>document.querySelector(sel);
const fmt = (x, d=4)=> (isFinite(x) ? Number(x).toFixed(d) : '—');
const downloadBlob = (content, filename, type='text/csv;charset=utf-8')=>{
  const blob = new Blob([content], {type});
  const a = document.createElement('a');
  const url = URL.createObjectURL(blob);
  a.href = url; a.download = filename; a.click(); URL.revokeObjectURL(url);
}
function autoDetectLabel(v){
  if(v===undefined||v===null) return null;
  const s = String(v).trim();
  if(/阳/.test(s) || /^pos/i.test(s)) return 1;
  if(/阴/.test(s) || /^neg/i.test(s)) return 0;
  if(/^1$|^true$/i.test(s)) return 1;
  if(/^0$|^false$/i.test(s)) return 0;
  return null;
}
function buildPreviewTable(rows){
  const thead = $('#preview thead'); const tbody = $('#preview tbody');
  thead.innerHTML = ''; tbody.innerHTML = '';
  if(!rows.length) return;
  const htr = document.createElement('tr');
  Object.keys(rows[0]).forEach(k=>{ const th = document.createElement('th'); th.textContent = k; htr.appendChild(th); });
  thead.appendChild(htr);
  rows.slice(0,50).forEach(r=>{ const tr = document.createElement('tr'); Object.values(r).forEach(v=>{ const td = document.createElement('td'); td.textContent = v; tr.appendChild(td); }); tbody.appendChild(tr); });
}

// ======================= 读取文件 =======================
$('#file').addEventListener('change', async (e)=>{
  const f = e.target.files[0]; if(!f){return}
  const name = f.name.toLowerCase();
  if(name.endsWith('.csv')){
    const text = await f.text();
    const lines = text.split(/\r?\n/).filter(x=>x.trim().length>0);
    if(!lines.length){alert('CSV 为空'); return}
    HEADERS = lines[0].split(',');
    RAW_ROWS = lines.slice(1).map(line=>{ const cells = line.split(','); const obj = {}; HEADERS.forEach((h,i)=>obj[h.trim()] = (cells[i]??'').trim()); return obj; });
  }else{
    const data = await f.arrayBuffer();
    const wb = XLSX.read(data, {type:'array'});
    const sh = wb.Sheets[wb.SheetNames[0]];
    RAW_ROWS = XLSX.utils.sheet_to_json(sh, {defval:''});
    HEADERS = Object.keys(RAW_ROWS[0]||{});
  }
  ['#col-id','#col-label','#col-score'].forEach(id=>{ const el=$(id); el.innerHTML=''; HEADERS.forEach(h=>{const opt=document.createElement('option'); opt.value=h; opt.textContent=h; el.appendChild(opt);}); });
  if(HEADERS.length){
    const idIdx = HEADERS.findIndex(h=>/文库|样本|id|sample/i.test(h)); if(idIdx>=0) $('#col-id').selectedIndex=idIdx;
    const labelIdx = HEADERS.findIndex(h=>/金标准|label|真实|真值|truth/i.test(h)); if(labelIdx>=0) $('#col-label').selectedIndex=labelIdx;
    const scoreIdx = HEADERS.findIndex(h=>/rpm|score|分数|值|read|signal|fluor/i.test(h)); if(scoreIdx>=0) $('#col-score').selectedIndex=scoreIdx;
  }
  buildPreviewTable(RAW_ROWS);
});

// ======================= 解析与计算 =======================
$('#btn-parse').addEventListener('click', ()=>{
  if(!RAW_ROWS.length){ alert('请先选择数据文件'); return }
  const colId = $('#col-id').value; const colLabel=$('#col-label').value; const colScore=$('#col-score').value;
  if(!colId||!colLabel||!colScore){ alert('请先完成列映射'); return }

  const id=[], label=[], score=[];
  RAW_ROWS.forEach(r=>{ const s = parseFloat(r[colScore]); const lab = autoDetectLabel(r[colLabel]); if(!isNaN(s) && lab!==null){ id.push(r[colId]); label.push(lab); score.push(s); } });
  if(!label.length){ alert('未能提取有效的标签/评分数据'); return }
  DATA = {id, label, score};
  P = label.filter(x=>x===1).length; N = label.filter(x=>x===0).length;

  ROC = computeROC(label, score); const auc = trapezoidAUC(ROC.fpr, ROC.tpr);
  PRC = computePR(label, score); const ap = trapezoidAUC(PRC.recall, PRC.precision);

  $('#kpi-auc').textContent = fmt(auc,4);
  $('#kpi-ap').textContent  = fmt(ap,4);
  $('#kpi-p').textContent   = P; $('#kpi-n').textContent = N;

  $('#th-slider').min = 0; $('#th-slider').max = ROC.th.length-1; $('#th-slider').value = 0;
  $('#th-value').value = ROC.th[0] ?? '';

  drawROC(ROC, auc); drawPR(PRC, ap);
  setThresholdByIndex(0);
});

function uniqueSortedDesc(arr){ return Array.from(new Set(arr)).sort((a,b)=>b-a); }

function computeROC(labels, scores){
  const thresholds = uniqueSortedDesc(scores);
  const fpr=[], tpr=[], th=[]; const points=[]; const P = labels.filter(x=>x===1).length; const N = labels.filter(x=>x===0).length;
  thresholds.forEach(T=>{
    let tp=0,fp=0,tn=0,fn=0;
    for(let i=0;i<labels.length;i++){
      const pred = (scores[i] >= T) ? 1 : 0;
      if(pred===1 && labels[i]===1) tp++; else if(pred===1 && labels[i]===0) fp++; else if(pred===0 && labels[i]===1) fn++; else tn++;
    }
    const tpr_i = tp/(tp+fn||1); const fpr_i = fp/(fp+tn||1);
    tpr.push(tpr_i); fpr.push(fpr_i); th.push(T); points.push({T, tp,fp,tn,fn, sens:tpr_i, spec:tn/(tn+fp||1)});
  });
  if(fpr[0]!==0 || tpr[0]!==0){ fpr.unshift(0); tpr.unshift(0); th.unshift(Infinity); points.unshift({T:Infinity,tp:0,fp:0,tn:0,fn:0,sens:0,spec:1}); }
  if(fpr[fpr.length-1]!==1 || tpr[tpr.length-1]!==1){ fpr.push(1); tpr.push(1); th.push(-Infinity); points.push({T:-Infinity,tp:P,fp:N,tn:0,fn:0,sens:1,spec:0}); }
  return {fpr, tpr, th, points};
}

function computePR(labels, scores){
  const thresholds = uniqueSortedDesc(scores);
  const recall=[], precision=[], th=[]; const points=[]; const P = labels.filter(x=>x===1).length;
  thresholds.forEach(T=>{
    let tp=0,fp=0,tn=0,fn=0;
    for(let i=0;i<labels.length;i++){
      const pred = (scores[i] >= T) ? 1 : 0;
      if(pred===1 && labels[i]===1) tp++; else if(pred===1 && labels[i]===0) fp++; else if(pred===0 && labels[i]===1) fn++; else tn++;
    }
    const rec = tp/(tp+fn||1); const pre = tp/(tp+fp||1);
    recall.push(rec); precision.push(pre); th.push(T); points.push({T, tp,fp,tn,fn, recall:rec, precision:pre});
  });
  if(recall[0]!==0){ recall.unshift(0); precision.unshift(1); th.unshift(Infinity); points.unshift({T:Infinity,tp:0,fp:0,tn:0,fn:P, recall:0, precision:1}); }
  return {recall, precision, th, points};
}

function trapezoidAUC(x, y){ let area=0; for(let i=1;i<x.length;i++){ area += (x[i]-x[i-1]) * ((y[i]+y[i-1])/2); } return area; }

// ======================= 绘图（高分辨率 & 绿色方框标记） =======================
function drawROC(roc, auc){
  const trace  = { x: roc.fpr, y: roc.tpr, type:'scatter', mode:'lines+markers', name:`ROC (AUC=${fmt(auc,3)})` };
  const diag   = { x:[0,1], y:[0,1], type:'scatter', mode:'lines', name:'随机 (y=x)', line:{dash:'dot'} };
  const marker = { x:[0], y:[0], type:'scatter', mode:'markers', name:'当前阈值', marker:{size:12, symbol:'square-open', line:{width:2}, color:'#22c55e'} };
  Plotly.newPlot('roc', [trace, diag, marker], { title:'ROC 曲线', xaxis:{title:'假阳率 FPR', range:[-0.02,1.02], automargin:true}, yaxis:{title:'真阳率 TPR', range:[-0.02,1.02], automargin:true}, legend:{orientation:'h', y:-0.25}, paper_bgcolor:'rgba(0,0,0,0)', plot_bgcolor:'rgba(0,0,0,0)' }, {displaylogo:false, toImageButtonOptions:{scale:4}});
}
function drawPR(prc, ap){
  const trace  = { x: prc.recall, y: prc.precision, type:'scatter', mode:'lines+markers', name:`PR (AP=${fmt(ap,3)})` };
  const marker = { x:[0], y:[0], type:'scatter', mode:'markers', name:'当前阈值', marker:{size:12, symbol:'square-open', line:{width:2}, color:'#22c55e'} };
  Plotly.newPlot('pr',  [trace, marker], { title:'Precision-Recall 曲线', xaxis:{title:'召回率 Recall', range:[-0.02,1.02], automargin:true}, yaxis:{title:'精确率 Precision', range:[-0.02,1.02], automargin:true}, legend:{orientation:'h', y:-0.25}, paper_bgcolor:'rgba(0,0,0,0)', plot_bgcolor:'rgba(0,0,0,0)' }, {displaylogo:false, toImageButtonOptions:{scale:4}});
}

function nearestThresholdIndex(arr, T){
  if(!arr || !arr.length) return 0;
  const idx = arr.indexOf(T); if(idx!==-1) return idx;
  let best=0, bestDiff=Infinity; for(let i=0;i<arr.length;i++){ const d=Math.abs(arr[i]-T); if(d<bestDiff){bestDiff=d; best=i;} } return best;
}
function updateMarkers(T){
  const i = nearestThresholdIndex(ROC.th, T);
  Plotly.restyle('roc', {x:[[ROC.fpr[i]]], y:[[ROC.tpr[i]]]}, [2]);
  const j = nearestThresholdIndex(PRC.th, T);
  Plotly.restyle('pr',  {x:[[PRC.recall[j]]], y:[[PRC.precision[j]]]}, [1]);
}

// ======================= 阈值应用与指标 =======================
function metricsAtThreshold(T){
  let tp=0,fp=0,tn=0,fn=0;
  for(let i=0;i<DATA.label.length;i++){
    const pred = (DATA.score[i] >= T) ? 1 : 0; const y = DATA.label[i];
    if(pred===1 && y===1) tp++; else if(pred===1 && y===0) fp++; else if(pred===0 && y===1) fn++; else tn++;
  }
  const sens = tp/(tp+fn || 1), spec = tn/(tn+fp || 1);
  const acc = (tp+tn) / (tp+tn+fp+fn || 1); const prec = tp/(tp+fp || 1);
  const f1  = (2*prec*sens)/((prec+sens)||1);
  return {tp,fp,tn,fn,sens,spec,acc,f1};
}
function setThresholdByIndex(idx){
  if(!ROC.th.length) return; const i = Math.max(0, Math.min(idx, ROC.th.length-1)); const T = ROC.th[i];
  $('#th-slider').value = i; $('#th-value').value = T; applyThreshold(T);
}
function setThreshold(T){ const i = nearestThresholdIndex(ROC.th, T); setThresholdByIndex(i); }
function applyThreshold(T){
  if(!isFinite(T)) return;
  const m = metricsAtThreshold(T);
  $('#kpi-sens').textContent = fmt(m.sens,4);
  $('#kpi-spec').textContent = fmt(m.spec,4);
  $('#kpi-acc').textContent  = fmt(m.acc,4);
  $('#kpi-f1').textContent   = fmt(m.f1,4);
  $('#cm-tp').textContent = m.tp; $('#cm-fp').textContent = m.fp; $('#cm-fn').textContent = m.fn; $('#cm-tn').textContent = m.tn;
  updateMarkers(T);
}
$('#btn-apply-th').addEventListener('click', ()=>{ const T = Number($('#th-value').value); if(isNaN(T)){ alert('请输入有效阈值'); return } setThreshold(T); });
$('#th-slider').addEventListener('input', (e)=>{ setThresholdByIndex(Number(e.target.value)); });

// ======================= 最优阈值策略 =======================
function argmax(arr){ let bestI=0,bestV=-Infinity; for(let i=0;i<arr.length;i++){ if(arr[i]>bestV){bestV=arr[i]; bestI=i;} } return bestI }
function bestThreshold(type, w1=1, w2=1){
  const scores = ROC.points.map(p=>{
    const {sens,spec} = p;
    if(type==='youden')  return sens + spec - 1;
    if(type==='closest') return - Math.hypot(1 - sens, 0 - (1 - spec));
    if(type==='sens')    return sens + 1e-6*spec;
    if(type==='spec')    return spec + 1e-6*sens;
    if(type==='weight')  return w1*sens + w2*spec;
    return -Infinity;
  });
  return ROC.points[argmax(scores)];
}
$('#btn-opt-youden') .addEventListener('click', ()=>{ if(!ROC.points.length) return alert('请先解析数据'); const b=bestThreshold('youden');  setThreshold(b.T); });
$('#btn-opt-closest').addEventListener('click', ()=>{ if(!ROC.points.length) return alert('请先解析数据'); const b=bestThreshold('closest'); setThreshold(b.T); });
$('#btn-opt-sens')   .addEventListener('click', ()=>{ if(!ROC.points.length) return alert('请先解析数据'); const b=bestThreshold('sens');    setThreshold(b.T); });
$('#btn-opt-spec')   .addEventListener('click', ()=>{ if(!ROC.points.length) return alert('请先解析数据'); const b=bestThreshold('spec');    setThreshold(b.T); });
$('#btn-opt-weight') .addEventListener('click', ()=>{ if(!ROC.points.length) return alert('请先解析数据'); const w1=Number($('#w-sens').value)||1, w2=Number($('#w-spec').value)||1; const b=bestThreshold('weight', w1, w2); setThreshold(b.T); });

// ======================= 导出曲线点与图片 =======================
$('#btn-export-roc').addEventListener('click', ()=>{ if(!ROC.fpr.length) return alert('无 ROC 数据'); const header='threshold,fpr,tpr\n'; const rows=ROC.fpr.map((x,i)=>`${ROC.th[i]},${x},${ROC.tpr[i]}`).join('\n'); downloadBlob(header+rows, 'roc_points.csv'); });
$('#btn-export-pr').addEventListener('click', ()=>{ if(!PRC.recall.length) return alert('无 PR 数据'); const header='threshold,recall,precision\n'; const rows=PRC.recall.map((x,i)=>`${PRC.th[i]},${x},${PRC.precision[i]}`).join('\n'); downloadBlob(header+rows, 'pr_points.csv'); });
function savePNGBundle(){ Plotly.downloadImage('roc', {format:'png', filename:'roc_curve', scale:4}); Plotly.downloadImage('pr', {format:'png', filename:'pr_curve', scale:4}); }
$('#btn-save-png').addEventListener('click', savePNGBundle); $('#btn-download-images').addEventListener('click', savePNGBundle);
$('#btn-save-svg').addEventListener('click', ()=>{ Plotly.downloadImage('roc', {format:'svg', filename:'roc_curve'}); Plotly.downloadImage('pr', {format:'svg', filename:'pr_curve'}); });

// ======================= 模板与清空 =======================
$('#btn-download-template').addEventListener('click', ()=>{ const csv='文库号,金标准结果,RPM\n001,阳性,1500\n002,阴性,500\n003,阳性,2000\n004,阴性,300\n'; downloadBlob(csv, 'template.csv'); });
$('#btn-clear').addEventListener('click', ()=>{
  RAW_ROWS=[]; HEADERS=[]; DATA={id:[],label:[],score:[]}; ROC={fpr:[],tpr:[],th:[],points:[]}; PRC={recall:[],precision:[],th:[],points:[]};
  $('#preview thead').innerHTML=''; $('#preview tbody').innerHTML='';
  ['kpi-auc','kpi-ap','kpi-p','kpi-n','kpi-sens','kpi-spec','kpi-acc','kpi-f1','cm-tp','cm-fp','cm-fn','cm-tn','ci-out'].forEach(id=>{ const el=document.getElementById(id); if(el) el.textContent='—'; });
  Plotly.purge('roc'); Plotly.purge('pr');
  $('#th-slider').value=0; $('#th-value').value=''; $('#file').value='';
});

// ======================= AUC CI (Bootstrap, B=200) =======================
function aucFromData(lbl, scr){ const roc = computeROC(lbl, scr); return trapezoidAUC(roc.fpr, roc.tpr); }
function sampleIdxWithReplacement(n){ const idx=new Array(n); for(let i=0;i<n;i++){ idx[i]=Math.floor(Math.random()*n);} return idx; }
$('#btn-ci').addEventListener('click', ()=>{
  if(!$('#chk-ci').checked) { $('#ci-out').textContent='未勾选 CI 计算'; return }
  if(!DATA.label.length) { alert('请先解析数据'); return }
  const B=200, aucs=[]; const n=DATA.label.length;
  for(let b=0;b<B;b++){ const pick=sampleIdxWithReplacement(n); const lbl=pick.map(i=>DATA.label[i]); const scr=pick.map(i=>DATA.score[i]); aucs.push(aucFromData(lbl, scr)); }
  aucs.sort((a,b)=>a-b); const lo=aucs[Math.floor(0.025*B)], hi=aucs[Math.ceil(0.975*B)-1];
  $('#ci-out').textContent = `AUC 95% CI ≈ [${fmt(lo,3)}, ${fmt(hi,3)}] (B=${B})`;
});

// ======================= FAQ 弹窗 =======================
$('#btn-faq').addEventListener('click', ()=>{ $('#faq-modal').style.display='block'; });
$('#faq-close').addEventListener('click', ()=>{ $('#faq-modal').style.display='none'; });
