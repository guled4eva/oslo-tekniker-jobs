const fs = require('fs');

// All known faggrupper with their keywords to help pre-filter
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

// Search keywords to send to Arbeidsplassen
const SEARCH_TERMS = [
  'konstruksjonsingeniør',
  'byplanlegger',
  'VA-ingeniør',
  'energiingeniør',
  'mekatronikk',
  'automatisering',
  'elektronikkingeniør',
  'bioteknologi',
  'kjemiingeniør',
  'dataingeniør',
  'IT-ingeniør',
  'softwareutvikler',
  'sivilingeniør',
];

async function main() {
  const fetch = (await import('node-fetch')).default;

  // Load existing jobs
  let jobs = [];
  try { jobs = JSON.parse(fs.readFileSync('jobs.json', 'utf8')); } catch(e) { console.log('Starting fresh'); }

  // Track existing Arbeidsplassen URLs to avoid duplicates
  const existingUrls = new Set(jobs.map(j => j.url).filter(Boolean));
  const existingIds = new Set(jobs.map(j => j.arbeidsplassenId).filter(Boolean));

  console.log('Existing jobs:', jobs.length);
  console.log('Fetching from Arbeidsplassen...');

  // Fetch from Arbeidsplassen API
  const newListings = [];
  const seen = new Set();

  for (const term of SEARCH_TERMS) {
    try {
      const url = 'https://arbeidsplassen.nav.no/api/v2/ads?q=' + encodeURIComponent(term) + '&size=10&sort=published';
      const res = await fetch(url, {
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'Oslo Tekniker Samfund Job Board'
        }
      });

      if (!res.ok) {
        console.log('Arbeidsplassen error for "' + term + '":', res.status);
        continue;
      }

      const data = await res.json();
      const listings = data.content || data.ads || data || [];

      for (const ad of listings) {
        const adId = ad.uuid || ad.id || String(ad.id);
        const adUrl = ad.applicationUrl || ad.sourceurl || ('https://arbeidsplassen.nav.no/stillinger/stilling/' + adId);

        // Skip if already in our jobs or already seen this run
        if (existingUrls.has(adUrl) || existingIds.has(adId) || seen.has(adId)) continue;
        seen.add(adId);

        newListings.push({
          id: adId,
          url: adUrl,
          title: ad.title || '',
          employer: ad.employer?.name || ad.businessName || '',
          location: ad.locationList?.[0]?.city || ad.location || '',
          deadline: ad.applicationDue || ad.expires || '',
          description: ad.description || ad.adText || '',
          published: ad.published || ''
        });
      }

      // Small delay to be polite to the API
      await new Promise(r => setTimeout(r, 500));
    } catch(e) {
      console.log('Error fetching term "' + term + '":', e.message);
    }
  }

  console.log('Found ' + newListings.length + ' new listings to evaluate');

  if (newListings.length === 0) {
    console.log('No new listings found, done.');
    return;
  }

  // Send each listing to Gemini to categorize
  let added = 0;
  for (const listing of newListings) {
    try {
      const jobText = [
        'Title: ' + listing.title,
        'Employer: ' + listing.employer,
        'Location: ' + listing.location,
        'Description: ' + listing.description.slice(0, 3000)
      ].join('\n');

      const promptParts = [
        'You are helping categorize a Norwegian engineering job posting for Oslo Tekniker Samfund, a student engineering organization.',
        '',
        'Job posting:',
        jobText,
        '',
        'Available faggrupper:',
        deptList,
        '',
        'Does this job belong to ANY of the faggrupper above? Engineering jobs only — skip general office, sales, manual labor, or management jobs with no engineering focus.',
        '',
        'Return ONLY valid JSON:',
        '{',
        '  "relevant": true or false,',
        '  "title": "job title in Norwegian",',
        '  "company": "company name",',
        '  "location": "specific city in Norway, use Oslo if only region given",',
        '  "deadline": "YYYY-MM-DD or empty string",',
        '  "description": "clean description max 400 words, preserve paragraphs with \\n\\n",',
        '  "sections": ["exact dept name from list"]',
        '}',
        '',
        'If relevant is false, still return the JSON but sections can be empty.',
        'Pick 1-3 most relevant departments. Only use exact names from the list.',
      ];

      const geminiRes = await fetch(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=' + process.env.GEMINI_API_KEY,
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
      try { extracted = JSON.parse(clean); } catch(e) { console.log('Parse error for', listing.title); continue; }

      if (!extracted.relevant) {
        console.log('Not relevant:', listing.title);
        continue;
      }

      const resolvedSections = (extracted.sections || [])
        .map(deptName => allDepts.find(d => d.dept === deptName))
        .filter(Boolean)
        .map(d => ({ dept: d.dept, section: d.section, group: d.group }));

      if (resolvedSections.length === 0) {
        console.log('No sections matched for:', listing.title);
        continue;
      }

      // Format deadline
      let deadline = extracted.deadline || '';
      if (deadline && !deadline.match(/^\d{4}-\d{2}-\d{2}$/)) {
        try {
          const d = new Date(deadline);
          if (!isNaN(d)) deadline = d.toISOString().split('T')[0];
          else deadline = '';
        } catch(e) { deadline = ''; }
      }

      const newJob = {
        id: Date.now() + Math.floor(Math.random() * 1000),
        arbeidsplassenId: listing.id,
        title: extracted.title || listing.title,
        company: extracted.company || listing.employer,
        location: extracted.location || listing.location || 'Oslo',
        deadline,
        desc: extracted.description || '',
        sections: resolvedSections,
        url: listing.url,
        posted: new Date().toISOString().split('T')[0],
        source: 'arbeidsplassen'
      };

      jobs.push(newJob);
      existingUrls.add(listing.url);
      existingIds.add(listing.id);
      added++;
      console.log('Added:', newJob.title, '|', resolvedSections.map(s => s.dept).join(', '));

      // Delay between Gemini calls to avoid rate limiting
      await new Promise(r => setTimeout(r, 1000));

    } catch(e) {
      console.log('Error processing listing:', listing.title, e.message);
    }
  }

  // Remove jobs older than 60 days that came from Arbeidsplassen
  const sixtyDaysAgo = new Date();
  sixtyDaysAgo.setDate(sixtyDaysAgo.getDate() - 60);
  const before = jobs.length;
  jobs = jobs.filter(j => {
    if (j.source !== 'arbeidsplassen') return true; // keep manual jobs forever
    if (!j.posted) return true;
    return new Date(j.posted) > sixtyDaysAgo;
  });
  const removed = before - jobs.length;
  if (removed > 0) console.log('Removed', removed, 'expired Arbeidsplassen jobs');

  fs.writeFileSync('jobs.json', JSON.stringify(jobs, null, 2));
  console.log('Done! Added ' + added + ' new jobs. Total jobs: ' + jobs.length);
}

main().catch(e => { console.error('Fatal error:', e); process.exit(1); });
