import { NextResponse } from "next/server";
import { importIndiaJobs } from "@/lib/imported-jobs";
import { createClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
const ROLES = ["HR Coordinator","HR Executive","HR Operations","HR Operations Specialist","HR Onboarding","Onboarding Specialist","Recruitment Coordinator","Talent Acquisition Specialist","Recruitment Operations","HRIS Analyst","Employee Lifecycle","HR Administrator","HR Assistant","People Operations Coordinator","HR Compliance","HR Recruiter","Human Resources Officer","People & Culture Executive","Human Resources Support Specialist","HR Support Center Coordinator","Senior Human Resources Generalist"];
const SOURCES = [{ key: "linkedin", site: "linkedin.com/jobs/view" },{ key: "indeed", site: "in.indeed.com/viewjob" },{ key: "foundit", site: "foundit.in/job" },{ key: "naukri", site: "naukri.com/job-listings" }];
const GOA = /\b(goa|panaji|panjim|margao|mapusa|vasco(?: da gama)?|calangute|porvorim|verna|bardez|anjuna|candolim|betalbatim|mobor|taleigao)\b/i;
function decode(value: string) { return value.replace(/&amp;/g,"&").replace(/&#39;/g,"'").replace(/&quot;/g,'"').replace(/&nbsp;/g," "); }
function strip(value: string) { return decode(value.replace(/<[^>]+>/g," ").replace(/\s+/g," ").trim()); }
function absoluteUrl(href: string) { if (href.startsWith("/url?q=")) return decode(href.slice(7).split("&")[0]); if (href.startsWith("http")) return href; return null; }
function ageHours(value: string) { const t=value.toLowerCase(); if (/\bjust now\b|\btoday\b|\bhours? ago\b|\b1\s*hour\b/.test(t)) return 1; const m=t.match(/(\d+)\s*(day|week|month)s?\s*ago/); if (!m) return null; const n=Number(m[1]); return m[2].startsWith("week")?n*168:m[2].startsWith("month")?n*720:n*24; }
function companyFrom(title: string, text: string) { const clean=strip(title).replace(/\s*[|·-]\s*(LinkedIn|Indeed|Foundit|Naukri).*$/i,""); const loc=text.match(/([A-Z][A-Za-z0-9&.,'()\- ]{2,70})\s+(?:Goa|Panaji|Panjim|Margao|Mapusa|Vasco|Calangute|Verna|Bardez|Taleigao)\b/i); if(loc?.[1]) return loc[1].trim(); const parts=clean.split(/\s+[-–—|·]\s+/).map(s=>s.trim()).filter(Boolean); return parts.length>1 && !/job post|salary|jobs?$/i.test(parts[1]) ? parts[1] : "Unknown company"; }

// Google changes its result markup frequently. Instead of assuming an anchor wraps
// the H3, pair each H3 with the nearest preceding result anchor and inspect the
// surrounding result block. This matches the MjjYud structure used by Google today.
function extractResults(html: string, source: string) {
  const out:Array<{title:string,url:string,context:string}>=[];
  const h3Re=/<h3[^>]*>([\s\S]*?)<\/h3>/gi;
  const allowed=source==="linkedin"?"linkedin.com/jobs/":source==="indeed"?"indeed.com/":source==="foundit"?"foundit.in/":"naukri.com/";
  let match:RegExpExecArray|null;
  while((match=h3Re.exec(html))){
    const before=html.slice(Math.max(0,match.index-7000),match.index);
    const anchors=[...before.matchAll(/<a[^>]+href="([^"]+)"[^>]*>/gi)];
    if(!anchors.length) continue;
    const href=anchors[anchors.length-1][1]; const url=absoluteUrl(href); if(!url||!url.includes(allowed)) continue;
    const title=strip(match[1]); const context=strip(before.slice(Math.max(0,before.lastIndexOf("<div")))+match[0]+html.slice(match.index+match[0].length,Math.min(html.length,match.index+7000)));
    if(title&&!out.some(x=>x.url===url)) out.push({title,url,context});
  }
  return out.slice(0,20);
}
async function google(query:string){ const response=await fetch(`https://www.google.com/search?hl=en&num=10&q=${encodeURIComponent(query)}`,{headers:{"User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36","Accept-Language":"en-US,en;q=0.9"},cache:"no-store"}); if(!response.ok) throw new Error(`Google ${response.status}`); return response.text(); }
async function discover() {
  const cutoff = new Date(Date.now()-15*24*60*60*1000); const after=cutoff.toISOString().slice(0,10); const failures:string[]=[]; const discovered:Array<Record<string,unknown>>=[]; const sourceCounts:Record<string,number>=Object.fromEntries(SOURCES.map(s=>[s.key,0]));
  await Promise.all(SOURCES.map(async source=>{ try {
    // Separate role groups keep the Google query small enough to avoid silently
    // dropping terms and give each board a focused search request.
    const queries=[ROLES.slice(0,8),ROLES.slice(8,16),ROLES.slice(16)].map(group=>group.map(r=>`"${r}"`).join(" OR "));
    const pages=await Promise.all(queries.map(q=>google(`site:${source.site} (${q}) Goa after:${after}`)));
    for(const html of pages) for(const result of extractResults(html,source.key)){
      const age=ageHours(result.context); if(age!=null&&age>360) continue;
      if(!GOA.test(result.context)&&!GOA.test(result.title)) continue;
      const postedAt=age==null?new Date().toISOString():new Date(Date.now()-age*3600000).toISOString();
      discovered.push({title:result.title,company:companyFrom(result.title,result.context),location:"Goa",type:"Full-time",description:result.context.slice(0,12000),apply_url:result.url,source:source.key,posted_at:postedAt}); sourceCounts[source.key]++;
    }
  } catch(error){ failures.push(`${source.key}: ${error instanceof Error?error.message:String(error)}`); } }));
  const result=await importIndiaJobs({jobs:discovered,failures,source:"india-multi-source-vercel"}); return {ok:failures.length===0,windowDays:15,roles:ROLES,discovered:discovered.length,sourceCounts,failures,result};
}
export async function runGoaDiscovery() { const url=process.env.NEXT_PUBLIC_SUPABASE_URL; const key=process.env.SUPABASE_SERVICE_ROLE_KEY; if(!url||!key) throw new Error("Supabase server configuration is missing"); const client=createClient(url,key,{auth:{autoRefreshToken:false,persistSession:false}}); const {data:state}=await client.from("job_discovery_state").select("last_started_at").eq("id",true).maybeSingle(); const last=state?.last_started_at?new Date(state.last_started_at).getTime():0; if(Date.now()-last<6*60*60*1000) return {skipped:true,reason:"discovery ran within the last 6 hours"}; await client.from("job_discovery_state").upsert({id:true,last_started_at:new Date().toISOString()}); try { const result=await discover(); await client.from("job_discovery_state").update({last_finished_at:new Date().toISOString(),last_result:result}).eq("id",true); return result; } catch(error) { await client.from("job_discovery_state").update({last_finished_at:new Date().toISOString(),last_result:{error:String(error)}}).eq("id",true); throw error; } }
export async function GET(request:Request){ const secret=process.env.CRON_SECRET; if(!secret||request.headers.get("authorization")!==`Bearer ${secret}`) return NextResponse.json({error:"Unauthorized"},{status:401}); try { return NextResponse.json(await runGoaDiscovery()); } catch(error){ console.error("Daily job collection failed",error); return NextResponse.json({error:error instanceof Error?error.message:"Discovery failed"},{status:500}); } }
