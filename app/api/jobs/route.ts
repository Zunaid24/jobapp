import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { runGoaDiscovery } from "@/app/api/cron/jobs/route";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
const SELECT = "id,title,company,location,type,match_score,description,apply_url,contact_email,decision_maker_name,decision_maker_title,posted_at,source,company_id";
const WINDOW_DAYS = 15;
function db(){const url=process.env.NEXT_PUBLIC_SUPABASE_URL;const key=process.env.SUPABASE_SERVICE_ROLE_KEY;if(!url||!key)throw new Error("Supabase server configuration is missing");return createClient(url,key,{auth:{autoRefreshToken:false,persistSession:false}});}
function queryJobs(client:ReturnType<typeof db>,location:string,cutoff:string){return client.from("jobs").select(`${SELECT},collected_on`).eq("location",location).gte("posted_at",cutoff).lte("posted_at",new Date(Date.now()+60*60*1000).toISOString()).order("posted_at",{ascending:false,nullsFirst:false}).limit(location==="Remote"?20:100);}
export async function GET(request:Request){
  try{
    const location=new URL(request.url).searchParams.get("location")==="Remote"?"Remote":"Goa";
    const client=db();
    const cutoff=new Date(Date.now()-WINDOW_DAYS*24*60*60*1000).toISOString();
    const initial=await queryJobs(client,location,cutoff);
    if(initial.error)throw initial.error;
    const beforeJobs=initial.data??[];
    let discovery:null|Record<string,unknown>=null;
    let afterJobs=beforeJobs;
    if(location==="Goa"&&beforeJobs.length<5){
      try{
        console.info("[JobApp] Discovery starting",{beforeCount:beforeJobs.length,cutoff});
        const result=await runGoaDiscovery();
        discovery=result as Record<string,unknown>;
        const refreshed=await queryJobs(client,location,cutoff);
        if(refreshed.error){
          console.error("[JobApp] Post-discovery Supabase query failed",refreshed.error);
        }else{
          afterJobs=refreshed.data??beforeJobs;
          console.info("[JobApp] Discovery database result",{
            beforeCount:beforeJobs.length,
            discovered:Number((discovery as any)?.discovered||0),
            accepted:Number(((discovery as any)?.result as any)?.accepted||0),
            afterCount:afterJobs.length,
            afterJobs:afterJobs.map(j=>({id:j.id,title:j.title,company:j.company,source:j.source,posted_at:j.posted_at,match_score:j.match_score}))
          });
        }
      }catch(error){
        console.error("[JobApp] On-demand Goa discovery failed",error);
        discovery={error:error instanceof Error?error.message:"Discovery failed"};
      }
    }
    const finalJobs=afterJobs;
    const responseJobs=finalJobs.map(({collected_on,...job})=>({...job,match:job.match_score??0,company_details:null,decision_makers:[]}));
    const debug={
      beforeCount:beforeJobs.length,
      afterCount:afterJobs.length,
      returnedCount:responseJobs.length,
      databaseIds:afterJobs.map(j=>j.id),
      databaseJobs:afterJobs.map(j=>({id:j.id,title:j.title,company:j.company,source:j.source,posted_at:j.posted_at,match_score:j.match_score})),
      discoveryAccepted:Number(((discovery as any)?.result as any)?.accepted||0),
      discoveryFresh:Number(((discovery as any)?.result as any)?.fresh||0),
      discoveryDiscovered:Number((discovery as any)?.discovered||0)
    };
    console.info("[JobApp] Jobs response",debug);
    return NextResponse.json({jobs:responseJobs,remoteDailyLimit:20,freshnessDays:WINDOW_DAYS,source:"india-multi-source",discovery,debug},{headers:{"Cache-Control":"no-store, max-age=0"}});
  }catch(error){
    console.error("Jobs endpoint failed",error);
    return NextResponse.json({error:error instanceof Error?error.message:"Unable to load jobs"},{status:500});
  }
}
