'use strict';
const $ = s => document.querySelector(s);
const state = new Map();
let cursor = 0, busy = false, latest = null;
const format = (v, unit='', digits=0) => v == null ? 'no data' : `${v.toLocaleString('en-US',{maximumFractionDigits:digits})}${unit}`;
const clock = t => new Date(t).toLocaleTimeString('en-US');
const axisClock = t => new Intl.DateTimeFormat('en-GB', {
  hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'
}).format(t);
function node(tag, cls, text) { const n=document.createElement(tag);if(cls)n.className=cls;if(text!=null)n.textContent=text;return n; }
function metric(label,text,hot=false){const n=node('div','metric');n.append(node('span','',label),node('strong',hot?'hot':'',text));return n;}
const views = new Map();
const palette=['#78b4ff','#ffb478','#77d9be','#cc9dff','#ed92b4','#e6bd69','#80d9ef','#d5e878'];
const cardColors=new Map();
let plots=null;
function colorFor(card){
  if(!cardColors.has(card.uuid))cardColors.set(card.uuid,cardColors.size % palette.length);
  return cardColors.get(card.uuid);
}
function createChart(parent, title, unit, column, ceiling) {
  const wrap=node('div','chart'), heading=node('div','chart-title');
  const scale=node('span'), canvas=node('canvas'), from=node('span'), to=node('span');
  const titleGroup=node('span','chart-heading');
  titleGroup.append(node('strong','',title),scale);heading.append(titleGroup);
  canvas.setAttribute('role','img');canvas.setAttribute('aria-label',title+' over the selected period');
  const axis=node('div','axis');axis.append(from,to);
  const legend=node('div','legend');
  wrap.append(heading,legend,canvas,axis);parent.append(wrap);
  return {canvas,scale,from,to,unit,column,ceiling,legend,entries:new Map()};
}
function drawChart(view, cards, start, end) {
  const {canvas,scale,from,to,unit,column,legend,entries}=view;
  const active=new Set(cards.map(card=>card.uuid));
  for(const [uuid,entry] of entries)if(!active.has(uuid)){entry.remove();entries.delete(uuid);}
  const series=cards.map(card=>{
    const slot=colorFor(card);
    let entry=entries.get(card.uuid);
    if(!entry){entry=node('span',`legend-entry series-${slot}`);legend.append(entry);entries.set(card.uuid,entry);}
    entry.textContent=`#${card.index} ${card.name}${card.stale?' · stale':''}`;
    return {card,color:palette[slot],points:state.get(card.uuid)||[]};
  });
  let peak=1,count=0;
  for(const line of series)for(const p of line.points)if(p[0]>=start && p[column]!=null){peak=Math.max(peak,p[column]);count++;}
  const memoryIndex=latest.metrics.indexOf('memoryTotal');
  const ceiling=view.ceiling==='memory'?Math.max(0,...cards.map(card=>card.values[memoryIndex]||0)):view.ceiling;
  const max=Math.max(ceiling||0,peak*(ceiling?1:1.15));
  scale.textContent=` (0–${Math.ceil(max)} ${unit})`;
  from.textContent=`[ ${axisClock(start)} ...`;to.textContent=`... ${axisClock(end)} ]`;
  const width=canvas.getBoundingClientRect().width || 500,height=160,dpr=window.devicePixelRatio||1;
  canvas.width=width*dpr;canvas.height=height*dpr;
  const c=canvas.getContext('2d');c.scale(dpr,dpr);c.strokeStyle='#28374d';c.lineWidth=1;
  const left=78,right=78,top=12,bottom=height-8;
  const plotWidth=Math.max(1,width-left-right),plotHeight=bottom-top;
  c.font='11px system-ui';c.textAlign='right';c.textBaseline='middle';
  for(let tick=0;tick<=4;tick++){
    const value=max*tick/4,y=bottom-tick/4*plotHeight;
    c.beginPath();c.moveTo(left,y);c.lineTo(width-right,y);c.stroke();
    const label=format(value,' '+unit,value<10?1:0);
    c.fillStyle='#96a6bd';c.textAlign='right';c.fillText(label,left-8,y);
    c.textAlign='left';c.fillText(label,width-right+8,y);
  }
  for(const {color,points} of series){
    c.strokeStyle=color;c.lineWidth=1.7;c.beginPath();let previous=null;
    for(const p of points){if(p[0]<start)continue;const v=p[column];if(v==null){previous=null;continue;}
      const x=left+(p[0]-start)/(end-start)*plotWidth,y=bottom-v/max*plotHeight;
      if(previous==null || p[0]-previous>6500)c.moveTo(x,y);else c.lineTo(x,y);previous=p[0];
    }c.stroke();
  }
  if(!count){c.fillStyle='#96a6bd';c.font='13px system-ui';c.textAlign='left';c.fillText('No data yet',left+12,80);}
}
function ensurePlots(){
  if(plots)return;
  plots=[
    ['Temperature','°C',1,110],['GPU utilization','%',6,100],['Power','W',7],
    ['SM clock','MHz',2],['Memory clock','MHz',3],['VRAM usage','MiB',4,'memory']
  ].map(args=>createChart($('#graphs'),...args));
}

function createView(card) {
  const box=node('article','gpu'),heading=node('div','heading'),name=node('div');
  const title=node('h3'),badge=node('span','badge');
  name.append(title,node('p','uuid',card.uuid));heading.append(name,badge);box.append(heading);
  const metrics=node('div','metrics');
  const labels=['Temperature','GPU utilization','Power','SM clock','Memory clock','VRAM'];
  const fields=labels.map(label=>{const item=metric(label,'no data');metrics.append(item);return item.querySelector('strong');});
  const details=node('p','details'),warning=node('p','hot','High temperature: check GPU cooling and airflow.');
  warning.hidden=true;box.append(metrics,details,warning);$('#cards').append(box);
  return {box,title,badge,fields,details,warning};
}

function render(){
  if(!latest)return;
  const now=Date.now(),start=now-Number($('#range').value);
  const active=new Set(latest.cards.map(card=>card.uuid));
  for(const [uuid,view] of views)if(!active.has(uuid)){view.box.remove();views.delete(uuid);}
  $('#history').hidden=latest.cards.length===0;
  $('#empty').hidden=latest.cards.length>0;
  $('#empty').textContent=latest.error?'GPU data unavailable. Check the driver and nvidia-smi path.':'No NVIDIA GPUs detected.';
  for(const card of latest.cards){
    let view=views.get(card.uuid);
    if(!view){view=createView(card);views.set(card.uuid,view);}
    const values=Object.fromEntries(latest.metrics.map((m,i)=>[m,card.values[i]]));
    const stale=card.stale || now-card.lastSeen>6000;
    view.box.classList.toggle('stale',stale);
    view.title.textContent=`#${card.index}  ${card.name}`;
    view.badge.hidden=!stale;
    view.badge.textContent=stale?'Stale data':'';
    const texts=[format(values.temperature,' °C'),format(values.utilization,' %'),
      values.power==null?'no data':`${format(values.power,' W')} / ${format(values.powerLimit,' W')}`,
      format(values.smClock,' MHz'),format(values.memoryClock,' MHz'),
      values.memoryUsed==null||values.memoryTotal==null?'no data':`${format(values.memoryUsed/1024,'',1)} / ${format(values.memoryTotal/1024,' GiB',1)}`];
    texts.forEach((text,i)=>{view.fields[i].textContent=text;});
    view.fields[0].classList.toggle('hot',values.temperature>=80);
    view.details.textContent=`PCIe: ${values.pcieGeneration==null?'—':`Gen ${values.pcieGeneration}`} ×${values.pcieWidth??'—'} · Fan: ${format(values.fan,' %')} · Measured: ${clock(card.lastSeen)}`;
    view.warning.hidden=!(values.temperature>=80);
  }
  ensurePlots();
  for(const plot of plots)drawChart(plot,latest.cards,start,now);
}
async function poll(){
  if(busy || document.hidden)return;busy=true;
  try{
    const response=await fetch(`/api/gpus?since=${cursor}`,{signal:AbortSignal.timeout(10000)});
    if(!response.ok)throw Error(`HTTP ${response.status}`);
    const data=await response.json();
    // A restarted server has a new, shorter history. Refetch it on the next poll.
    if(latest && data.lastSuccess<latest.lastSuccess){state.clear();cursor=0;latest=data;return;}
    let nextCursor=cursor;
    for(const card of data.cards){const points=state.get(card.uuid)||[];const tail=points.at(-1)?.[0]||0;
      for(const p of card.history){if(p[0]>tail)points.push(p);nextCursor=Math.max(nextCursor,p[0]);}
      const cutoff=data.now-14400000;let trim=0;while(trim<points.length && points[trim][0]<cutoff)trim++;if(trim)points.splice(0,trim);
      if(points.length>7200)points.splice(0,points.length-7200);state.set(card.uuid,points);
    }
    for(const uuid of state.keys())if(!data.cards.some(c=>c.uuid===uuid))state.delete(uuid);
    cursor=nextCursor;latest=data;
    $('#status').hidden=!data.demo&&!data.error;
    $('#status').textContent=data.demo?'DEMO · synthetic data':data.error?'Polling error':'';
    const notice=$('#notice');notice.hidden=!data.error&&!data.demo;
    notice.textContent=[data.demo?'Demo mode: values are synthetic; hardware is not queried.':'',data.error].filter(Boolean).join('\n');render();
  }catch(e){$('#status').hidden=false;$('#status').textContent='Server disconnected';$('#notice').hidden=false;$('#notice').textContent=`Unable to refresh data: ${e.message}`;if(latest){for(const c of latest.cards)c.stale=true;render();}}
  finally{busy=false;}
}
$('#range').addEventListener('change',render);window.addEventListener('resize',render);document.addEventListener('visibilitychange',()=>{if(!document.hidden)poll();});
poll();setInterval(poll,2000);
