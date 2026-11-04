(function(){
if(matchMedia("(prefers-reduced-motion: reduce)").matches||!matchMedia("(hover: hover) and (pointer: fine)").matches)return;
var g=document.createElement("div");g.className="cglow";document.body.appendChild(g);
var tx=-999,ty=-999,x=-999,y=-999,run=false;
function loop(){x+=(tx-x)*.12;y+=(ty-y)*.12;g.style.transform="translate3d("+x+"px,"+y+"px,0)";if(Math.abs(tx-x)+Math.abs(ty-y)>.5)requestAnimationFrame(loop);else run=false}
addEventListener("pointermove",function(e){tx=e.clientX;ty=e.clientY;g.classList.add("on");if(!run){run=true;requestAnimationFrame(loop)}},{passive:true});
document.addEventListener("mouseleave",function(){g.classList.remove("on")});
function bind(){
document.querySelectorAll(".card,.fc,.stat,.steps li,.ly,.repo,.fees>div,.cnt>div,.lic2>div,.honest2").forEach(function(el){if(el.dataset.fx)return;el.dataset.fx=1;el.classList.add("fxs");
 el.addEventListener("pointermove",function(e){var r=el.getBoundingClientRect(),px=e.clientX-r.left,py=e.clientY-r.top;el.style.setProperty("--mx",px+"px");el.style.setProperty("--my",py+"px");
  var rx=(py/r.height-.5)*-8,ry=(px/r.width-.5)*8;el.style.transform="perspective(800px) rotateX("+rx+"deg) rotateY("+ry+"deg) translateY(-4px)"});
 el.addEventListener("pointerleave",function(){el.style.transform=""})});
document.querySelectorAll(".btn,.chip,.tab,.lang").forEach(function(el){if(el.dataset.mg)return;el.dataset.mg=1;el.classList.add("mag");
 el.addEventListener("pointermove",function(e){var r=el.getBoundingClientRect();el.style.transform="translate("+((e.clientX-r.left-r.width/2)*.25)+"px,"+((e.clientY-r.top-r.height/2)*.35)+"px)"});
 el.addEventListener("pointerleave",function(){el.style.transform=""})});}
bind();new MutationObserver(bind).observe(document.body,{childList:true,subtree:true});
var ph=document.querySelector(".phone");
if(ph)addEventListener("pointermove",function(e){var cx=e.clientX/innerWidth-.5,cy=e.clientY/innerHeight-.5;ph.style.transform="perspective(1000px) rotateY("+cx*14+"deg) rotateX("+(-cy*10)+"deg)"},{passive:true});
})();
