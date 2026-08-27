import { NextResponse } from "next/server";
import { importIndiaJobs } from "@/lib/imported-jobs";
import { createClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
const ROLES = ["HR Coordinator","HR Executive","HR Operations","HR Operations Specialist","HR Onboarding","Onboarding Specialist","Recruitment Coordinator","Talent Acquisition Specialist","Recruitment Operations","HRIS Analyst","Employee Lifecycle","HR Administrator","HR Assistant","People Operations Coordinator","HR Compliance","HR Recruiter","Human Resources Officer","People & Culture Executive","Human Resources Support Specialist","HR Support Center Coordinator","Senior Human Resources Generalist"];
const SOURCES = [{ key: "linkedin", sites: ["linkedin.com/jobs/","linkedin.com/jobs/view"] },{ key: "indeed", sites: ["in.indeed.com/","indeed.com/viewjob"] },{ key: "foundit", sites: ["foundit.in/","foundit.in/job"] },{ key: "naukri", sites: ["naukri.com/","naukri.com/job-listings"] }];
const GOA = /\b(goa|panaji|panjim|margao|mapusa|vasco(?: da gama)?|calangute|porvorim|verna|bardez|anjuna|candolim|betalbatim|mobor|taleigao)\b/i;
function decode(value: string) { let v=value; for(let i=0;i<3;i++){ try{v=decodeURIComponent(v);}catch{} } return v.replace(/&amp;/g,"&").replace(/&#39;/g,"'").replace(/&quot;/g,'"').replace(/&#x2F;/gi,"/").replace(/&#x3D;/gi,"=").replace(/&nbsp;/g," "); }
function strip(value: string) { return decode(value.replace(/<[^>]+>/g," ").replace(/\s+/g," ").trim()); }
function absoluteUrl(href: string) {
  const h=decode(href.trim());
  if(/^https?:\/\//i.test(h)) { try { const u=new URL(h); const target=u.searchParams.get("url")||u.searchParams.get("q")||u.searchParams.get("uddg"); if(target&&/^https?:\/\//i.test(target)) return decode(target); } catch{} return h; }
  const q=h.match(/(?:[?&](?:q|url|uddg|u)=)(https?[^&]+)/i); if(q) return decode(q[1]);
  if(h.startsWith("/url?")) { try { const u=new URL(`https://www.google.com${h}`); for(const key of ["q","url"]) { const target=u.searchParams.get(key); if(target&&/^https?:\/\//i.test(target)) return decode(target); } } catch{} }
  return null;
}
function ageHours(value: string) { const t=value.toLowerCase(); if (/\bjust now\b|\btoday\b|\bhours? ago\b|\b1\s*hour\b/.test(t)) return 1; const m=t.match(/(\d+)\s*(day|week|month)s?\s*ago/); if (!m) return null; const n=Number(m[1]); return m[2].startsWith("week")?n*168:m[2].startsWith("month")?n*720:n*24; }
function companyFrom(title: string, text: string) { const clean=strip(title).replace(/\s*[|·-]\s*(LinkedIn|Indeed|Foundit|Naukri).*$/i,""); const loc=text.match(/([A-Z][A-Za-z0-9&.,'()\- ]{2,70})\s+(?:Goa|Panaji|Panjim|Margao|Mapusa|Vasco|Calangute|Verna|Bardez|Taleigao)\b/i); if(loc?.[1]) return loc[1].trim(); const parts=clean.split(/\s+[-–—|·]\s+/).map(s=>s.trim()).filter(Boolean); return parts.length>1 && !/job post|salary|jobs?$/i.test(parts[1]) ? parts[1] : "Unknown company"; }

type SearchResult={title:string;url:string;context:string};
function keepResult(title:string,url:string,context:string,source:{key:string;sites:string[]}) { return /^https?:\/\//i.test(url) && source.sites.some(s=>url.toLowerCase().includes(s)) && !!title; }
function extractGoogleResults(html: string, source: {key:string;sites:string[]}) {
  const out:SearchResult[]=[]; const h3Re=/<h3[^>]*>([\s\S]*?)<\/h3>/gi; let match:RegExpExecArray|null;
  while((match=h3Re.exec(html)) !== null){ const start=Math.max(0,match.index-12000), end=Math.min(html.length,match.index+12000), block=html.slice(start,end); const anchors=[...block.matchAll(/<a[^>]+href\s*=\s*["']([^"']+)["'][^>]*>/gi)]; const url=anchors.map(a=>absoluteUrl(a[1])).find(u=>u&&keepResult(strip(match[1]),u,strip(block),source))||null; if(!url) continue; const title=strip(match[1]),context=strip(block); if(!out.some(x=>x.url===url)) out.push({title,url,context}); }
  return out.slice(0,30);
}
function extractBingResults(html: string, source: {key:string;sites:string[]}) { const out:SearchResult[]=[]; const re=/<li\b[^>]*class=["'][^"']*b_algo[^"']*["'][\s\S]*?<\/li>/gi; let m:RegExpExecArray|null; while((m=re.exec(html))){ const block=m[0],a=block.match(/<h2[^>]*>\s*<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i); if(!a) continue; const url=absoluteUrl(a[1]),title=strip(a[2]),context=strip(block); if(url&&keepResult(title,url,context,source)&&!out.some(x=>x.url===url)) out.push({title,url,context}); } return out.slice(0,30); }
function extractDuckResults(html: string, source: {key:string;sites:string[]}) { const out:SearchResult[]=[]; const re=/<article[\s\S]*?<\/article>/gi; let m:RegExpExecArray|null; while((m=re.exec(html))){ const block=m[0],a=block.match(/<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i); if(!a) continue; const url=absoluteUrl(a[1]),title=strip(a[2]),context=strip(block); if(url&&keepResult(title,url,context,source)&&!out.some(x=>x.url===url)) out.push({title,url,context}); } return out.slice(0,30); }
async function searchEngine(query:string, source:{key:string;sites:string[]}) {
  const headers={"User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36","Accept-Language":"en-US,en;q=0.9"};
  try { const google=await fetch(`https://www.google.com/search?gbv=1&hl=en&num=10&q=${encodeURIComponent(query)}`,{headers,cache:"no-store"}); if(google.ok){ const html=await google.text(),results=extractGoogleResults(html,source); if(results.length) return results; } } catch {}
  try { const bing=await fetch(`https://www.bing.com/search?count=10&q=${encodeURIComponent(query)}`,{headers,cache:"no-store"}); if(bing.ok){ const results=extractBingResults(await bing.text(),source); if(results.length) return results; } } catch {}
  const duck=await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,{headers,cache:"no-store"}); if(!duck.ok) throw new Error(`All search engines unavailable (DuckDuckGo ${duck.status})`); return extractDuckResults(await duck.text(),source);
}
async function discover() {
  const cutoff = new Date(Date.now()-15*24*60*60*1000); const after=cutoff.toISOString().slice(0,10); const failures:string[]=[]; const discovered:Array<Record<string,unknown>>=[]; const sourceCounts:Record<string,number>=Object.fromEntries(SOURCES.map(s=>[s.key,0]));
  await Promise.all(SOURCES.map(async source=>{ try {
    const roleQueries=ROLES.map(r=>`"${r}" Goa after:${after} site:${source.sites[0]}`);
    const pages=await Promise.all(roleQueries.map(q=>searchEngine(q,source)));
    const seen=new Set<string>();
    for(const results of pages) for(const result of results){
      if(seen.has(result.url)) continue; seen.add(result.url); const age=ageHours(result.context); if(age!=null&&age>360) continue; if(!GOA.test(result.context)&&!GOA.test(result.title)) continue;
      const postedAt=age==null?new Date().toISOString():new Date(Date.now()-age*3600000).toISOString(); discovered.push({title:result.title,company:companyFrom(result.title,result.context),location:"Goa",type:"Full-time",description:result.context.slice(0,12000),apply_url:result.url,source:source.key,posted_at:postedAt}); sourceCounts[source.key]++;
    }
  } catch(error){ failures.push(`${source.key}: ${error instanceof Error?error.message:String(error)}`); } }));
  const result=await importIndiaJobs({jobs:discovered,failures,source:"india-multi-source-vercel"}); return {ok:failures.length===0,windowDays:15,roles:ROLES,discovered:discovered.length,sourceCounts,failures,result};
}
export async function runGoaDiscovery() { const url=process.env.NEXT_PUBLIC_SUPABASE_URL; const key=process.env.SUPABASE_SERVICE_ROLE_KEY; if(!url||!key) throw new Error("Supabase server configuration is missing"); const client=createClient(url,key,{auth:{autoRefreshToken:false,persistSession:false}}); const {data:state}=await client.from("job_discovery_state").select("last_started_at").eq("id",true).maybeSingle(); const last=state?.last_started_at?new Date(state.last_started_at).getTime():0; if(Date.now()-last<6*60*60*1000) return {skipped:true,reason:"discovery ran within the last 6 hours"}; await client.from("job_discovery_state").upsert({id:true,last_started_at:new Date().toISOString()}); try { const result=await discover(); await client.from("job_discovery_state").update({last_finished_at:new Date().toISOString(),last_result:result}).eq("id",true); return result; } catch(error) { await client.from("job_discovery_state").update({last_finished_at:new Date().toISOString(),last_result:{error:String(error)}}).eq("id",true); throw error; } }
export async function GET(request:Request){ const secret=process.env.CRON_SECRET; if(!secret||request.headers.get("authorization")!==`Bearer ${secret}`) return NextResponse.json({error:"Unauthorized"},{status:401}); try { return NextResponse.json(await runGoaDiscovery()); } catch(error){ console.error("Daily job collection failed",error); return NextResponse.json({error:error instanceof Error?error.message:"Discovery failed"},{status:500}); } }
