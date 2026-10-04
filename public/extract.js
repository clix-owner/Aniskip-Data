    $("extractMediaIds").onclick=()=>{
      try{
        const startEpisode=Number($("bulkStart").value), endEpisode=Number($("bulkEnd").value);
        if(!Number.isInteger(startEpisode)||!Number.isInteger(endEpisode)||startEpisode<1||endEpisode<startEpisode) throw new Error("Enter a valid start and end episode first.");
        const parsed=JSON.parse($("bulkEpisodesJson").value);
        const episodes=Array.isArray(parsed)?parsed:parsed?.data;
        if(!Array.isArray(episodes)) throw new Error("Paste a Crunchyroll episodes JSON response with a data array.");
        const markerSpecial=(item)=>{
          const label=String(item?.episode||"").trim().toUpperCase();
          const title=String(item?.title||"").trim();
          const numericLabel=Number(label);
          const fractionalEpisode=Number.isFinite(numericLabel)&&!Number.isInteger(numericLabel);
          return fractionalEpisode||/^SP(?:[0-9]+)?$/.test(label)||label==="RECAP"||label==="SPECIAL"||/^SPECIAL EPISODE\s*:/i.test(title);
        };
        // A Crunchyroll seasons response can include a small companion
        // special-season. The most common non-SP season is the requested main
        // season; records from other season IDs are treated as specials.
        // Crunchyroll season IDs are locale/version specific. The same logical
        // season may appear as e.g. GS00371932ENUS for dubbed entries and
        // GS00371932JAJP for original-only/newer entries. Compare the stable
        // season-id base instead of the locale-suffixed raw ID, otherwise valid
        // episodes can be misclassified as specials.
        const seasonBase=(seasonId)=>String(seasonId||"").trim().replace(/(?:[A-Z]{4}|[A-Z]{2}\d{3})$/i,"");
        const seasonCounts=new Map();
        for(const item of episodes){
          if(markerSpecial(item)||!item?.season_id) continue;
          const key=seasonBase(item.season_id);
          if(key) seasonCounts.set(key,(seasonCounts.get(key)||0)+1);
        }
        const mainSeasonId=[...seasonCounts.entries()].sort((a,b)=>b[1]-a[1])[0]?.[0]||null;
        const belongsToMainSeason=(item)=>!mainSeasonId||!item?.season_id||seasonBase(item.season_id)===mainSeasonId;
        // Some numbered specials are not marked SP by Crunchyroll. Kaiju No. 8,
        // for example, puts "Hoshina's Day Off" first as episode 1, followed by
        // the real, contiguous episode 13..23 run. Treat that isolated leading
        // number as a special only when every following main-season item forms
        // a contiguous integer run; a normal season starting at 1 is unchanged.
        const mainSeasonCandidates=episodes
          .filter(item=>!markerSpecial(item)&&belongsToMainSeason(item))
          .sort((a,b)=>Number(a?.sequence_number)-Number(b?.sequence_number));
        const contextualSpecials=new Set();
        if(mainSeasonCandidates.length>=3){
          const [first,...rest]=mainSeasonCandidates;
          const firstNumber=Number(first?.episode_number??first?.episode);
          const restNumbers=rest.map(item=>Number(item?.episode_number??item?.episode));
          const restIsContiguous=restNumbers.every((number,index)=>Number.isInteger(number)&&(index===0||number===restNumbers[index-1]+1));
          if(Number.isInteger(firstNumber)&&restIsContiguous&&restNumbers[0]>firstNumber+1) contextualSpecials.add(first);
        }
        const isSpecial=(item)=>markerSpecial(item)||!belongsToMainSeason(item)||contextualSpecials.has(item);
        const mediaIdFor=(item)=>{
          const versions=Array.isArray(item?.versions)?item.versions:[];
          const original=versions.find(version=>version?.original===true&&String(version?.guid||"").trim())
            ||versions.find(version=>version?.audio_locale==="ja-JP"&&String(version?.guid||"").trim());
          return String(original?.guid||item?.id||"").trim();
        };
        bulkSpecials=episodes.filter(isSpecial).map(item=>({
          episode:String(item?.episode||item?.episode_number||"Special"),
          episodeNumber:item?.episode_number??null,
          mediaId:mediaIdFor(item),
          title:String(item?.title||"").trim()
        }));
        const normalEpisodes=episodes.filter(item=>!isSpecial(item));
        // Crunchyroll sequence_number can count an inserted recap (for
        // example episode 13.5) and shift every following normal episode by
        // one. season_order ranks only the remaining normal records, so a
        // requested 1..N season range stays contiguous after specials are
        // removed.
        const orderedNormal=[...normalEpisodes].sort((a,b)=>{
          const left=Number(a?.sequence_number),right=Number(b?.sequence_number);
          return (Number.isFinite(left)?left:Number.MAX_SAFE_INTEGER)-(Number.isFinite(right)?right:Number.MAX_SAFE_INTEGER);
        });
        const seasonOrder=new Map(orderedNormal.map((item,index)=>[item,index+1]));
        const numberingFields=[
          {name:"episode_number",number:item=>Number(item?.episode_number)},
          {name:"sequence_number",number:item=>Number(item?.sequence_number)},
          {name:"episode",number:item=>Number(item?.episode)},
          {name:"season_order",number:item=>seasonOrder.get(item)}
        ];
        const fieldScore=(strategy)=>{
          const seen=new Set();
          for(const item of normalEpisodes){
            const number=strategy.number(item);
            if(Number.isInteger(number)&&number>=startEpisode&&number<=endEpisode) seen.add(number);
          }
          return seen.size;
        };
        const numberingField=numberingFields
          .map((strategy,index)=>({...strategy,index,score:fieldScore(strategy)}))
          .sort((a,b)=>b.score-a.score||a.index-b.index)[0];
        if(!numberingField||numberingField.score===0) throw new Error(`No episode numbering field matches range ${startEpisode}–${endEpisode}.`);
        const byEpisode=new Map(), duplicates=[];
        for(const item of normalEpisodes){
          const number=numberingField.number(item), id=mediaIdFor(item);
          if(!Number.isInteger(number)||number<startEpisode||number>endEpisode||!id) continue;
          if(byEpisode.has(number)) duplicates.push(number); else byEpisode.set(number,id);
        }
        const missing=[]; for(let number=startEpisode;number<=endEpisode;number+=1) if(!byEpisode.has(number)) missing.push(number);
        if(duplicates.length) throw new Error(`More than one Media ID found for episode: ${[...new Set(duplicates)].join(", ")}. Paste one audio/version response only.`);
        if(missing.length) throw new Error(`No Media ID found for episode: ${missing.join(", ")}.`);
        $("bulkMediaIds").value=Array.from({length:endEpisode-startEpisode+1},(_,index)=>byEpisode.get(startEpisode+index)).join("\n");
        const specials=bulkSpecials.length?` Specials skipped: ${bulkSpecials.length} — ${bulkSpecials.map(x=>`${x.episode}: ${x.title} (${x.mediaId})`).join(", ")}.`:" Specials skipped: 0.";
        const numberingLabel=numberingField.name==="sequence_number"?"season-relative sequence_number":numberingField.name==="season_order"?"normal-episode season order":numberingField.name;
        bulkStatus(`Extracted ${endEpisode-startEpisode+1} normal Media IDs for episodes ${startEpisode}–${endEpisode} using ${numberingLabel}.${specials}`,true);
      }catch(error){bulkStatus(error.message)}
    };
