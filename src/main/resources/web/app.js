'use strict';
const $ = s => document.querySelector(s);
const state = new Map();
let cursor = 0, busy = false, latest = null;
const format = (v, unit='', digits=0) => v == null ? 'no data' : `${v.toLocaleString('en-US',{maximumFractionDigits:digits})}${unit}`;
const clock = t => new Date(t).toLocaleTimeString('en-US');
function node(tag, cls, text) { const n=document.createElement(tag);if(cls)n.className=cls;if(text!=null)n.textContent=text;return n; }
function metric(label,text,hot=false){const n=node('div','metric');n.append(node('span','',label),node('strong',hot?'hot':'',text));return n;}
const views = new Map();
function createChart(parent, title, unit, color, column, ceiling) {
  const wrap=node('div','chart'), heading=node('div','chart-title');
  const scale=node('span'), canvas=node('canvas'), from=node('span'), to=node('span');
  heading.append(node('span','',title),scale);
  canvas.setAttribute('role','img');canvas.setAttribute('aria-label',title+' over the selected period');
  const axis=node('div','axis');axis.append(from,to);
  wrap.append(heading,canvas,axis);parent.append(wrap);
  return {canvas,scale,from,to,unit,color,column,ceiling};
}
function drawChart(view, points, start, end, memoryTotal) {
  const {canvas,scale,from,to,unit,color,column}=view;
  const valid=points.filter(p=>p[0]>=start && p[column]!=null);
  const max=(view.ceiling==='memory' ? memoryTotal : view.ceiling) || Math.max(1,...valid.map(p=>p[column]))*1.15;
  scale.textContent=`0–${Math.ceil(max)} ${unit}`;
  from.textContent=clock(start);to.textContent=clock(end);
  const width=canvas.getBoundingClientRect().width || 500,height=160,dpr=window.devicePixelRatio||1;
  canvas.width=width*dpr;canvas.height=height*dpr;
  const c=canvas.getContext('2d');c.scale(dpr,dpr);c.strokeStyle='#28374d';c.lineWidth=1;
  for(let y=20;y<height;y+=40){c.beginPath();c.moveTo(0,y);c.lineTo(width,y);c.stroke();}
  c.strokeStyle=color;c.lineWidth=1.7;c.beginPath();let previous=null;
  for(const p of points){if(p[0]<start)continue;const v=p[column];if(v==null){previous=null;continue;}
    const x=(p[0]-start)/(end-start)*width,y=height-8-v/max*(height-20);
    if(previous==null || p[0]-previous>6500)c.moveTo(x,y);else c.lineTo(x,y);previous=p[0];
  }c.stroke();
  if(!valid.length){c.fillStyle='#96a6bd';c.font='13px system-ui';c.fillText('No data yet',15,80);}
}
function createView(card) {
  const box=node('article','gpu'),heading=node('div','heading'),name=node('div');
  const title=node('h3'),badge=node('span','badge');
  name.append(title,node('p','uuid',card.uuid));heading.append(name,badge);box.append(heading);
  const metrics=node('div','metrics');
  const labels=['Temperature','SM clock','Memory clock','GPU utilization','VRAM','Power'];
  const fields=labels.map(label=>{const item=metric(label,'no data');metrics.append(item);return item.querySelector('strong');});
  const details=node('p','details'),warning=node('p','hot','High temperature: check GPU cooling and airflow.');
  warning.hidden=true;box.append(metrics,details,warning);$('#cards').append(box);
  const graphBox=node('article','gpu'),graphTitle=node('h3'),charts=node('div','charts');
  graphBox.append(graphTitle,charts);$('#graphs').append(graphBox);
  const plots=[
    ['Temperature','°C','#ffb478',1,110],['SM clock','MHz','#78b4ff',2],
    ['Memory clock','MHz','#e6bd69',3],['GPU utilization','%','#77d9be',6,100],
    ['VRAM usage','MiB','#ed92b4',4,'memory'],['Power','W','#cc9dff',7]
  ].map(args=>createChart(charts,...args));
  return {box,title,badge,fields,details,warning,graphBox,graphTitle,plots};
}
function render(){
  if(!latest)return;
  const now=Date.now(),start=now-Number($('#range').value);
  const active=new Set(latest.cards.map(card=>card.uuid));
  for(const [uuid,view] of views)if(!active.has(uuid)){view.box.remove();view.graphBox.remove();views.delete(uuid);}
  $('#history').hidden=latest.cards.length===0;
  $('#empty').hidden=latest.cards.length>0;
  $('#empty').textContent=latest.error?'GPU data unavailable. Check the driver and nvidia-smi path.':'No NVIDIA GPUs detected.';
  for(const card of latest.cards){
    let view=views.get(card.uuid);
    if(!view){view=createView(card);views.set(card.uuid,view);}
    const values=Object.fromEntries(latest.metrics.map((m,i)=>[m,card.values[i]]));
    const stale=card.stale || now-card.lastSeen>6000;
    view.box.classList.toggle('stale',stale);view.graphBox.classList.toggle('stale',stale);
    view.title.textContent=view.graphTitle.textContent=`#${card.index}  ${card.name}`;
    view.badge.textContent=stale?'Stale data':`Updated ${clock(card.lastSeen)}`;
    const texts=[format(values.temperature,' °C'),format(values.smClock,' MHz'),format(values.memoryClock,' MHz'),format(values.utilization,' %'),
      values.memoryUsed==null||values.memoryTotal==null?'no data':`${format(values.memoryUsed/1024,'',1)} / ${format(values.memoryTotal/1024,' GiB',1)}`,
      values.power==null?'no data':`${format(values.power,' W')} / ${format(values.powerLimit,' W')}`];
    texts.forEach((text,i)=>{view.fields[i].textContent=text;});
    view.fields[0].classList.toggle('hot',values.temperature>=80);
    view.details.textContent=`PCIe: ${values.pcieGeneration==null?'—':`Gen ${values.pcieGeneration}`} ×${values.pcieWidth??'—'} · Fan: ${format(values.fan,' %')} · Measured: ${clock(card.lastSeen)}`;
    view.warning.hidden=!(values.temperature>=80);
    const points=state.get(card.uuid)||[];
    for(const plot of view.plots)drawChart(plot,points,start,now,values.memoryTotal);
  }
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
    $('#status').textContent=data.demo?'DEMO · synthetic data':data.error?'Polling error':'Monitoring active';
    const notice=$('#notice');notice.hidden=!data.error&&!data.demo;
    notice.textContent=[data.demo?'Demo mode: values are synthetic; hardware is not queried.':'',data.error].filter(Boolean).join('\n');render();
  }catch(e){$('#status').textContent='Server disconnected';$('#notice').hidden=false;$('#notice').textContent=`Unable to refresh data: ${e.message}`;if(latest){for(const c of latest.cards)c.stale=true;render();}}
  finally{busy=false;}
}
$('#range').addEventListener('change',render);window.addEventListener('resize',render);document.addEventListener('visibilitychange',()=>{if(!document.hidden)poll();});
poll();setInterval(poll,2000);
