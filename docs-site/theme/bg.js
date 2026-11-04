(function(){var $=function(s){return document.querySelector(s)};
  /* ---------- WebGL aurora background ---------- */
  var cv = $("#bg");
  var reduce = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
  var gl = cv && (cv.getContext("webgl",{antialias:false,alpha:false,powerPreference:"low-power"}) || cv.getContext("experimental-webgl"));
  if(!gl){ if(cv) cv.style.display="none"; return; }
  var vs="attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}";
  var fs=[
    "precision highp float;",
    "uniform vec2 r;uniform float t;uniform vec2 m;uniform float sc;",
    "float h(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}",
    "float n(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);",
    " return mix(mix(h(i),h(i+vec2(1,0)),f.x),mix(h(i+vec2(0,1)),h(i+vec2(1,1)),f.x),f.y);}",
    "float fbm(vec2 p){float v=0.,a=.5;mat2 R=mat2(.8,.6,-.6,.8);for(int i=0;i<5;i++){v+=a*n(p);p=R*p*2.02;a*=.5;}return v;}",
    "void main(){",
    " vec2 uv=gl_FragCoord.xy/r; vec2 p=(gl_FragCoord.xy-.5*r)/min(r.x,r.y);",
    " float T=t*.05;",
    " p+= (m-.5)*.12;",
    " vec2 q=vec2(fbm(p*1.4+T),fbm(p*1.4-T+3.1));",
    " vec2 w=vec2(fbm(p*1.7+2.*q+vec2(1.7,9.2)+T*1.3),fbm(p*1.7+2.*q+vec2(8.3,2.8)-T));",
    " float f=fbm(p*1.2+2.4*w);",
    " vec3 c0=vec3(.02,.024,.04);",
    " vec3 vio=vec3(.49,.36,1.);vec3 cy=vec3(.08,.78,.93);vec3 mi=vec3(.2,.96,.77);vec3 pk=vec3(1.,.37,.82);",
    " vec3 col=mix(c0,vio*.9,smoothstep(.38,.85,f));",
    " col=mix(col,cy*.9,smoothstep(.5,.95,w.x)*.8);",
    " col=mix(col,pk*.75,smoothstep(.6,1.,q.y)*.45);",
    " col=mix(col,mi*.7,smoothstep(.7,1.05,f*w.y*1.6)*.35);",
    " float band=exp(-pow((p.y-.18*sin(p.x*1.6+t*.18)-.05)*3.2,2.));",
    " col+=band*vec3(.25,.2,.6)*(.5+.5*f);",
    " float vig=smoothstep(1.35,.2,length(p*vec2(.8,1.)));",
    " col*=vig;",
    " col*=mix(1.,.38,sc);",
    " col=pow(col,vec3(.95));",
    " gl_FragColor=vec4(col,1.);",
    "}"].join("\n");
  function sh(type,src){var s=gl.createShader(type);gl.shaderSource(s,src);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS)){throw gl.getShaderInfoLog(s);}return s;}
  try{
    var pr=gl.createProgram();gl.attachShader(pr,sh(gl.VERTEX_SHADER,vs));gl.attachShader(pr,sh(gl.FRAGMENT_SHADER,fs));gl.linkProgram(pr);gl.useProgram(pr);
  }catch(err){ cv.style.display="none"; return; }
  var b=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,b);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,3,-1,-1,3]),gl.STATIC_DRAW);
  var loc=gl.getAttribLocation(pr,"p");gl.enableVertexAttribArray(loc);gl.vertexAttribPointer(loc,2,gl.FLOAT,false,0,0);
  var uR=gl.getUniformLocation(pr,"r"),uT=gl.getUniformLocation(pr,"t"),uM=gl.getUniformLocation(pr,"m"),uS=gl.getUniformLocation(pr,"sc");
  var mx=.5,my=.5,tx=.5,ty=.5;
  window.addEventListener("pointermove",function(e){tx=e.clientX/innerWidth;ty=1-e.clientY/innerHeight;},{passive:true});
  var DPR=Math.min(window.devicePixelRatio||1,1.5), SCALE=.5;
  function size(){ var w=Math.max(1,Math.floor(cv.clientWidth*DPR*SCALE)), h=Math.max(1,Math.floor(cv.clientHeight*DPR*SCALE)); if(cv.width!==w||cv.height!==h){cv.width=w;cv.height=h;gl.viewport(0,0,w,h);} }
  window.addEventListener("resize",size); size();
  var t0=performance.now(), visible=true;
  document.addEventListener("visibilitychange",function(){visible=!document.hidden; if(visible) requestAnimationFrame(frame);});
  function frame(now){
    mx+=(tx-mx)*.04; my+=(ty-my)*.04;
    var s=0;
    gl.uniform2f(uR,cv.width,cv.height); gl.uniform1f(uT,reduce?8.:(now-t0)/1000+8.); gl.uniform2f(uM,mx,my); gl.uniform1f(uS,s);
    gl.drawArrays(gl.TRIANGLES,0,3);
    if(visible && !reduce){ if(window.scrollY > cv.clientHeight){ setTimeout(function(){requestAnimationFrame(frame)},250); } else requestAnimationFrame(frame); }
  }
  requestAnimationFrame(frame);
})();
