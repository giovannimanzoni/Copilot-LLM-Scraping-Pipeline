# MANDATORY: Session Start Protocol

At the start of EVERY session:
1. Wait user prompt
2. Understand if you need to edit coordinator or worker project or both
3. Read appropriate context snapshot:
   1. For coordinator project read `llm-scraping-coordinator/.claude/context/context_snapshot.md` — this is your 
   complete memory of coordinator project about previous sessions. No other files need to be read; the snapshot is 
   always current.
   2. For worker project read `llm-scraping-coordinator/.claude/context/context_snapshot.md` — this is your complete 
   memory of worker project about previous sessions. No other files need to be read; the snapshot is always current.
4. Plan what to do and ask user confirmation before proceeding