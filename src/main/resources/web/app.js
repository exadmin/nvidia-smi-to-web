'use strict';
const $ = s => document.querySelector(s);
const state = new Map();
let cursor = 0, busy = false, latest = null;
const format = (v, unit='', digits=0) => v == null ? 'no data' : `${v.toLocaleString('en-US',{maximumFractionDigits:digits})}${unit}`;
const clock = t => new Date(t).toLocaleTimeString('en-US');
function node(tag, cls, text) { const n=document.createElement(tag);if(cls)n.className=cls;if(text!=null)n.textContent=text;return n; }
function metric(label,text,hot=false){const n=node('div','metric');n.append(node('span','',label),node('strong',hot?'hot':'',text));return n;}
function chart(parent, title, unit, color, points, column, start, end, ceiling) {
  const wrap=node('div','chart'), heading=node('div','chart-title');
  const valid=points.filter(p=>p[0]>=start && p[column]!=null);
  const max=ceiling || Math.max(1,...valid.map(p=>p[column]))*1.15;
  heading.append(node('span','',title),node('span','',`0–${Math.ceil(max)} ${unit}`));
  const canvas=node('canvas');canvas.setAttribute('role','img');canvas.setAttribute('aria-label',title+' over the selected period');
  const axis=node('div','axis');axis.append(node('span','',clock(start)),node('span','',clock(end)));
  wrap.append(heading,canvas,axis);parent.append(wrap);
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
function render(){
  if(!latest)return;
  const now=Date.now(),start=now-Number($('#range').value),container=$('#cards');container.replaceChildren();
  const graphs=$('#graphs');graphs.replaceChildren();
  $('#history').hidden=latest.cards.length===0;
  $('#empty').hidden=latest.cards.length>0;
  $('#empty').textContent=latest.error?'GPU data unavailable. Check the driver and nvidia-smi path.':'No NVIDIA GPUs detected.';
  for(const card of latest.cards){
    const values=Object.fromEntries(latest.metrics.map((m,i)=>[m,card.values[i]]));
    const stale=card.stale || now-card.lastSeen>6000;
    const box=node('article','gpu'+(stale?' stale':'')),heading=node('div','heading'),name=node('div');
    name.append(node('h3','',`#${card.index}  ${card.name}`),node('p','uuid',card.uuid));
    heading.append(name,node('span','badge',stale?'Stale data':`Updated ${clock(card.lastSeen)}`));box.append(heading);
    const metrics=node('div','metrics');
    metrics.append(metric('Temperature',format(values.temperature,' °C'),values.temperature>=80),metric('SM clock',format(values.smClock,' MHz')),metric('Memory clock',format(values.memoryClock,' MHz')),metric('GPU utilization',format(values.utilization,' %')),metric('VRAM',values.memoryUsed==null||values.memoryTotal==null?'no data':`${format(values.memoryUsed/1024,'',1)} / ${format(values.memoryTotal/1024,' GiB',1)}`),metric('Power',values.power==null?'no data':`${format(values.power,' W')} / ${format(values.powerLimit,' W')}`));box.append(metrics);
    box.append(node('p','details',`PCIe: ${values.pcieGeneration==null?'—':`Gen ${values.pcieGeneration}`} ×${values.pcieWidth??'—'} · Fan: ${format(values.fan,' %')} · Measured: ${clock(card.lastSeen)}`));
    if(values.temperature>=80)box.append(node('p','hot','High temperature: check GPU cooling and airflow.'));
    container.append(box);
    const graphBox=node('article','gpu'+(stale?' stale':''));
    graphBox.append(node('h3','',`#${card.index}  ${card.name}`));
    const charts=node('div','charts');graphBox.append(charts);graphs.append(graphBox);
    const points=state.get(card.uuid)||[];
    chart(charts,'Temperature','°C','#ffb478',points,1,start,now,110);
    chart(charts,'SM clock','MHz','#78b4ff',points,2,start,now);
    chart(charts,'Memory clock','MHz','#e6bd69',points,3,start,now);
    chart(charts,'GPU utilization','%', '#77d9be',points,6,start,now,100);
    chart(charts,'VRAM usage','MiB','#ed92b4',points,4,start,now,values.memoryTotal);
    chart(charts,'Power','W','#cc9dff',points,7,start,now);
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
