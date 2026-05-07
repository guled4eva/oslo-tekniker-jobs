const fs = require('fs');

const allDepts = [
  { dept: 'Konstruksjonsteknikk', section: 'bygg', group: 'be' },
  { dept: 'By- og transportplanlegging', section: 'bygg', group: 'be' },
  { dept: 'Vann- og miljøteknikk', section: 'bygg', group: 'be' },
  { dept: 'Energi og miljø', section: 'energi', group: 'be' },
  { dept: 'Mekatronikk', section: 'maskin', group: 'mek' },
  { dept: 'Konstruksjon og design', section: 'maskin', group: 'mek' },
  { dept: 'Automatisering og robotikk', section: 'elektro', group: 'mek' },
  { dept: 'Elektronikk', section: 'elektro', group: 'mek' },
  { dept: 'Bioteknologi', section: 'kjemi', group: 'mek' },
  { dept: 'Kjemiingeniør', section: 'kjemi', group: 'mek' },
  { dept: 'Anvendt datateknologi', section: 'it', group: 'it' },
  { dept: 'Dataingeniør', section: 'it', group: 'it' },
  { dept: 'Informasjonsteknologi', section: 'it', group: 'it' },
  { dept: 'Matematisk modellering og datavitenskap – ingeniør', section: 'it', group: 'it' },
];

const deptList = allDepts.map(d => '- ' + d.dept).join('\n');

// Keywords to pre-filter relevant ads before sending to Gemini
const RELEVANT_KEYWORDS = [
  'ingeniør', 'engineer', 'sivilingeniør', 'konstruksjon', 'byplanlegg',
  'vann', 'avløp', 'energi', 'mekatronikk', 'automatisering', 'robotikk',
  'elektronikk', 'bioteknologi', 'kjemi', 'dataingeniør', 'software',
  'utvikler', 'tekniker', 'teknolog', 'maskin', 'elektro', 'bygg',
  'infrastruktur', 'transport', 'miljøteknikk', 'programvare'
];

function isLikelyRelevant(title, description) {
  const text = (title + ' ' + description).toLowerCase();
  return RELEVANT_KEYWORDS.some(kw => text.includes(kw));
}

async function main() {
  const fetch = (await import('node-fetch')).default;

  const NAV_TOKEN = process.env.NAV_API_TOKEN;
  const GEMINI_KEY = process.env.GEMINI_API_KEY;

  if (!NAV_TOKEN) { console.log('NAV_API_TOKEN not set'); process.exit(1); }
  if (!GEMINI_KEY) { console.log('GEMINI_API_KEY not set'); process.exit(1); }

  // Load existing jobs
  let jobs = [];
  try { jobs = JSON.parse(fs.readFileSync('jobs.json', 'utf8')); } catch(e) { console.log('Starting with empty jobs.json'); }

  const existingNavIds = new Set(jobs.map(j => j.arbeidsplassenId).filter(Boolean));
  const existingUrls  = new Set(jobs.map(j => j.url).filter(Boolean));
  console.log('Existing jobs:', jobs.length);

  // Fetch latest feed page from NAV
  console.log('Fetching NAV feed...');
  let feedItems = [];

  try {
    const res = await fetch('https://pam-stilling-feed.nav.no/api/v1/feed', {
      headers: {
        'Authorization': 'Bearer ' + NAV_TOKEN,
        'Accept': 'application/json'
      }
    });
    console.log('NAV feed HTTP status:', res.status);
    if (!res.ok) {
      const txt = await res.text();
      console.log('Error body:', txt.slice(0, 400));
      process.exit(1);
    }
    const data = await res.json();
    feedItems = (data.items || []);
    console.log('Total feed items:', feedItems.length);
  } catch(e) {
    console.log('Failed to fetch NAV feed:', e.message);
    process.exit(1);
  }

  // Only active ads we haven't seen before
  const candidates = feedItems.filter(item => {
    const entry = item._feed_entry || {};
    if (entry.status !== 'ACTIVE') return false;
    const adId = entry.id || entry.uuid;
    const adUrl = item.url || ('https://arbeidsplassen.nav.no/stillinger/stilling/' + adId);
    if (existingNavIds.has(String(adId))) return false;
    if (existingUrls.has(adUrl)) return false;
    return true;
  });

  console.log('New active candidates:', candidates.length);

  // For each candidate, fetch the full ad and check relevance
  let added = 0;
  const MAX_TO_PROCESS = 50; // limit per run to avoid timeout

  for (const item of candidates.slice(0, MAX_TO_PROCESS)) {
    try {
      const entry = item._feed_entry || {};
      const adId = String(entry.id || entry.uuid || '');
      const adUrl = item.url
        ? 'https://pam-stilling-feed.nav.no' + item.url
        : null;

      // Fetch full ad details
      let ad = {};
      if (adUrl) {
        const adRes = await fetch(adUrl, {
          headers: { 'Authorization': 'Bearer ' + NAV_TOKEN, 'Accept': 'application/json' }
        });
        if (adRes.ok) ad = await adRes.json();
      }

      const title = ad.title || entry.title || '';
      const description = ad.description || ad.adText || '';
      const employer = ad.employer?.name || ad.businessName || '';
      const locationCity = ad.locationList?.[0]?.city || ad.location || 'Oslo';
      const deadline = ad.applicationDue || ad.expires || '';
      const publicUrl = 'https://arbeidsplassen.nav.no/stillinger/stilling/' + adId;

      // Pre-filter by keyword before calling Gemini
      if (!isLikelyRelevant(title, description)) {
        continue;
      }

      console.log('Evaluating:', title);

      // Ask Gemini if it fits and which dept
      const promptParts = [
        'You are helping categorize a Norwegian engineering job posting for Oslo Tekniker Samfund, a student engineering organization.',
        '',
        'Job title: ' + title,
        'Employer: ' + employer,
        'Description: ' + description.slice(0, 2000),
        '',
        'Available faggrupper:',
        deptList,
        '',
        'Does this job belong to ANY of the faggrupper above? Only include engineering/technical roles — skip management, sales, general office, or manual labor roles with no engineering focus.',
        '',
        'Return ONLY valid JSON:',
        '{',
        '  "relevant": true or false,',
        '  "title": "job title in Norwegian",',
        '  "company": "company name",',
        '  "location": "specific city in Norway, use Oslo if only region given",',
        '  "deadline": "YYYY-MM-DD or empty string",',
        '  "description": "clean description max 400 words, paragraphs separated by \\n\\n",',
        '  "sections": ["exact dept name from list"]',
        '}',
        '',
        'sections must use ONLY exact names from the list. Pick 1-3 most relevant.',
      ];

      const geminiRes = await fetch(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=' + GEMINI_KEY,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: promptParts.join('\n') }] }],
            generationConfig: { temperature: 0.1 }
          })
        }
      );

      const geminiData = await geminiRes.json();
      const raw = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
      const clean = raw.replace(/```json|```/g, '').trim();

      let extracted = {};
      try { extracted = JSON.parse(clean); } catch(e) { console.log('Parse error for', title); continue; }

      if (!extracted.relevant) {
        console.log('Not relevant:', title);
        continue;
      }

      const resolvedSections = (extracted.sections || [])
        .map(deptName => allDepts.find(d => d.dept === deptName))
        .filter(Boolean)
        .map(d => ({ dept: d.dept, section: d.section, group: d.group }));

      if (resolvedSections.length === 0) {
        console.log('No sections matched for:', title);
        continue;
      }

      // Format deadline
      let dl = extracted.deadline || deadline || '';
      if (dl && !dl.match(/^\d{4}-\d{2}-\d{2}$/)) {
        try { const d = new Date(dl); if (!isNaN(d)) dl = d.toISOString().split('T')[0]; else dl = ''; }
        catch(e) { dl = ''; }
      }

      const newJob = {
        id: Date.now() + Math.floor(Math.random() * 9999),
        arbeidsplassenId: adId,
        title: extracted.title || title,
        company: extracted.company || employer,
        location: extracted.location || locationCity,
        deadline: dl,
        desc: extracted.description || '',
        sections: resolvedSections,
        url: publicUrl,
        posted: new Date().toISOString().split('T')[0],
        source: 'arbeidsplassen'
      };

      jobs.push(newJob);
      existingNavIds.add(adId);
      existingUrls.add(publicUrl);
      added++;
      console.log('Added:', newJob.title, '|', resolvedSections.map(s => s.dept).join(', '));

      // Be polite to both APIs
      await new Promise(r => setTimeout(r, 1200));

    } catch(e) {
      console.log('Error processing item:', e.message);
    }
  }

  // Remove Arbeidsplassen jobs older than 60 days
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 60);
  const before = jobs.length;
  jobs = jobs.filter(j => {
    if (j.source !== 'arbeidsplassen') return true;
    if (!j.posted) return true;
    return new Date(j.posted) > cutoff;
  });
  const removed = before - jobs.length;
  if (removed > 0) console.log('Removed', removed, 'expired Arbeidsplassen jobs');

  fs.writeFileSync('jobs.json', JSON.stringify(jobs, null, 2));
  console.log('Done! Added', added, '| Total jobs:', jobs.length);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
