export const motionPreference=()=>matchMedia('(prefers-reduced-motion: reduce)').matches;
const active=new WeakMap();
export function enter(element,{distance=7,duration=180}={}){
 if(!element||motionPreference())return;
 active.get(element)?.cancel();
 const animation=element.animate([{opacity:0,transform:`translateY(${distance}px)`},{opacity:1,transform:'translateY(0)'}],{duration,easing:'cubic-bezier(.2,.7,.2,1)'});
 active.set(element,animation);animation.finished.catch(()=>{}).finally(()=>{if(active.get(element)===animation)active.delete(element)});
}
export async function exit(element,{distance=5,duration=150}={}){
 if(!element||motionPreference())return;
 active.get(element)?.cancel();const animation=element.animate([{opacity:1,transform:'translateY(0)'},{opacity:0,transform:`translateY(${distance}px)`}],{duration,easing:'cubic-bezier(.4,0,1,1)',fill:'forwards'});active.set(element,animation);await animation.finished.catch(()=>{});
}
export async function layout(element,change,{duration=260}={}){
 if(!element)return change();
 if(motionPreference()){change();return}
 element.classList.add('layout-changing');
 element.getBoundingClientRect();change();
 await new Promise(resolve=>setTimeout(resolve,duration+20));
 element.classList.remove('layout-changing');
}
export function collapse(element,change){
 const previous=active.get(element);const start=element.getBoundingClientRect().height;previous?.cancel();element.style.maxHeight='';change();const end=element.getBoundingClientRect().height;
 if(motionPreference()||Math.abs(start-end)<1)return;
 element.style.maxHeight='none';const animation=element.animate([{height:start+'px',opacity:start?1:0},{height:end+'px',opacity:end?1:0}],{duration:220,easing:'cubic-bezier(.2,.7,.2,1)'});active.set(element,animation);animation.finished.catch(()=>{}).finally(()=>{if(active.get(element)===animation){element.style.maxHeight='';active.delete(element)}});
}
export function highlight(element){if(element&&!motionPreference())element.animate([{backgroundColor:'#d6c3f0aa'},{backgroundColor:'transparent'}],{duration:650,easing:'ease-out'})}
