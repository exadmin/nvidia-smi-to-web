// DOM lifecycle regression: regular polling must preserve the scrollable page structure.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
class Element {
  constructor(tag) { this.tag=tag;this.children=[];this.value='300000';this.classList={toggle(){}}; }
  append(...children) { for(const child of children){child.parent=this;this.children.push(child);} }
  querySelector(tag) { return this.children.find(c=>c.tag===tag) || this.children.map(c=>c.querySelector(tag)).find(Boolean); }
  setAttribute() {}
  addEventListener() {}
  getBoundingClientRect() { return {width:500}; }
  getContext() { return new Proxy({}, {get:()=>()=>{}}); }
  remove() { this.parent.children=this.parent.children.filter(c=>c!==this); }
}
const elements=new Map(['#range','#cards','#graphs','#history','#empty'].map(id=>[id,new Element('div')]));
const context=vm.createContext({
  document:{hidden:true,querySelector:id=>elements.get(id),createElement:tag=>new Element(tag),addEventListener(){}},
  window:{devicePixelRatio:1,addEventListener(){}},setInterval(){},console
});
vm.runInContext(fs.readFileSync('src/main/resources/web/app.js','utf8'),context);
vm.runInContext(`
  latest={metrics:['temperature','smClock','memoryClock','memoryUsed','memoryTotal','utilization','power','powerLimit','fan','pcieGeneration','pcieWidth'],cards:[
    {uuid:'GPU-a',index:0,name:'P100',lastSeen:Date.now(),values:[45,1200,715,1024,16384,20,90,250,null,3,16]},
    {uuid:'GPU-b',index:1,name:'P100',lastSeen:Date.now(),values:[46,1200,715,1024,16384,20,90,250,null,3,16]}
  ]};render();
`,context);
const firstCards=[...elements.get('#cards').children];
const firstGraphs=[...elements.get('#graphs').children];
const firstCanvas=firstGraphs[0].querySelector('canvas');
vm.runInContext(`latest.cards[0].values[0]=55;render();render();`,context);
assert.deepEqual(elements.get('#cards').children,firstCards);
assert.deepEqual(elements.get('#graphs').children,firstGraphs);
assert.equal(firstGraphs[0].querySelector('canvas'),firstCanvas);
assert.equal(firstCards[0].querySelector('strong').textContent,'55 °C');
assert.equal(vm.runInContext("views.get('GPU-a').fields.map(field=>field.textContent).join('|')",context),
  '55 °C|20 %|90 W / 250 W|1,200 MHz|715 MHz|1 / 16 GiB');
assert.equal(firstGraphs[0].querySelector('strong').textContent,'Temperature');
elements.get('#range').value='60000';
vm.runInContext('render()',context);
assert.equal(firstGraphs[0].querySelector('canvas'),firstCanvas);
vm.runInContext('latest.cards.shift();render()',context);
assert.equal(elements.get('#cards').children.length,1);
assert.equal(elements.get('#cards').children[0],firstCards[1]);
assert.equal(elements.get('#graphs').children[0],firstGraphs[0]);
assert.equal(firstGraphs.length,6);
assert.equal(vm.runInContext('plots[0].entries.size',context),1);
assert.equal(vm.runInContext("plots.every(p=>p.entries.get('GPU-b').className==='legend-entry series-1')",context),true);
assert.equal(vm.runInContext("plots.map(p=>p.column).join(',')",context),'1,6,7,2,3,4');
console.log('PASS: persistent cards/canvases, six metric rows, shared GPU colors, legend reconciliation');
