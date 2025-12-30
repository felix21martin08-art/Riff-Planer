let current='fish';
function setCat(c){current=c;render();}
function saveLiter(){localStorage.setItem('literset',liter.value);}
function render(){
let L=parseInt(localStorage.getItem('literset')||0);
let data=[...tiere,...JSON.parse(localStorage.getItem('tiere_custom')||'[]')];
if(current==='besatz'){data=JSON.parse(localStorage.getItem('besatz')||'[]'); renderBesatzWarnings();}
if(['fish','invert','coral'].includes(current))data=data.filter(x=>x.type===current);
let out="";
data.forEach(t=>{
 let warn=L<t.min; let st= warn?'🔴':L===0?'🟡':'🟢';
 out+=`<div class='card ${warn?'warn':''}' onclick="openD('${t.name}')"><img src='${t.img}'><div>${t.name}</div><div class='status'>${st}</div></div>`;
});
document.getElementById('list').innerHTML=out;}
function openD(n){localStorage.setItem('details_item',n);location.href='details.html';}
render();

// --- Extra: show warnings in Mein Becken ---
function renderBesatzWarnings(){
 let L=parseInt(localStorage.getItem('literset')||0);
 let b=JSON.parse(localStorage.getItem('besatz')||'[]');
 let warnings=[];
 // simple heuristic: doctorfish check
 let docs=b.filter(x=>x.name.toLowerCase().includes("dokt"));
 if(docs.length>1 && L<400){
   warnings.push("⚠️ Mehrere Doktorfische in kleinen Becken können Revierkämpfe verursachen.");
 }
 if(b.length>0 && L<100){
   warnings.push("⚠️ Becken sehr klein für aktuellen Besatz. Stress möglich.");
 }
 let w = warnings.length ? warnings.join("\n") : "";
 if(w) alert(w);
}

// call in render when in besatz


// --- REMOVE BESATZ FEATURE ---
function removeFromBesatz(name){
  let b = JSON.parse(localStorage.getItem("besatz")||"[]");
  b = b.filter(x => x.name !== name);
  localStorage.setItem("besatz", JSON.stringify(b));
  render('besatz');
}

function clearBesatz(){
  if(confirm("Willst du wirklich den kompletten Besatz löschen?")){
    localStorage.removeItem("besatz");
    render('besatz');
  }
}
