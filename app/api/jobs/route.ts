import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { runGoaDiscovery } from "@/app/api/cron/jobs/route";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
const SELECT = "id,title,company,location,type,match_score,description,apply_url,contact_email,decision_maker_name,decision_maker_title,posted_at,source,company_id";
const WINDOW_DAYS = 15;
function db(){const url=process.env.NEXT_PUBLIC_SUPABASE_URL;const key=process.env.SUPABASE_SERVICE_ROLE_KEY;if(!url||!key)throw new Error("Supabase server configuration is missing");return createClient(url,key,{auth:{autoRefreshToken:false,persistSession:false}});}
export async function GET(request:Request){
  try{
    const location=new URL(request.url).searchParams.get("location")==="Remote"?"Remote":"Goa"; const client=db(); const cutoff=new Date(Date.now()-WINDOW_DAYS*24*60*60*1000).toISOString();
    const {data:jobs,error}=await client.from("jobs").select(`${SELECT},collected_on`).eq("location",location).gte("posted_at",cutoff).lte("posted_at",new Date(Date.now()+60*60*1000).toISOString()).order("posted_at",{ascending:false,nullsFirst:false}).limit(location==="Remote"?20:100); if(error)throw error;
    let discovery:null|Record<string,unknown>=null;
    if(location==="Goa"&&(jobs??[]).length<5){try{const result=await runGoaDiscovery(); discovery=result as Record<string,unknown>;}catch(error){console.error("On-demand Goa discovery failed",error);discovery={error:error instanceof Error?error.message:"Discovery failed"};}}
    let finalJobs=jobs??[];
    if(discovery&&!("error" in discovery)&&!("skipped" in discovery)){const refreshed=await client.from("jobs").select(`${SELECT},collected_on`).eq("location",location).gte("posted_at",cutoff).lte("posted_at",new Date(Date.now()+60*60*1000).toISOString()).order("posted_at",{ascending:false,nullsFirst:false}).limit(100);if(!refreshed.error)finalJobs=refreshed.data??finalJobs;}
    return NextResponse.json({jobs:finalJobs.map(({collected_on,...job})=>({...job,match:job.match_score??0,company_details:null,decision_makers:[]})),remoteDailyLimit:20,freshnessDays:WINDOW_DAYS,source:"india-multi-source",discovery});
  }catch(error){console.error("Jobs endpoint failed",error);return NextResponse.json({error:error instanceof Error?error.message:"Unable to load jobs"},{status:500});}
}
