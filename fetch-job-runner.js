const fs = require('fs');

async function main() {
  const fetch = (await import('node-fetch')).default;

  const payload = JSON.parse(process.env.JOB_PAYLOAD);
  const { url, jobText, id, posted } = payload;

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

  const prompt = [
    'You are helping categorize a Norwegian engineering job posting for Oslo Tekniker Samfund.',
    '',
    'Job posting text:',
    jobText || '(no text provided)',
    '',
    url ? 'Original URL: ' + url : '',
    '',
    'Available faggrupper (departments):',
    deptList,
    '',
    'Extract all job information and determine which faggruppe(r) this job belongs to.',
    '',
    'Return ONLY valid JSON, no markdown, no code blocks, no explanation:',
    '{',
    '  "title": "job title",',
    '  "company": "company name",',
    '  "location": "city or municipality in Norway",',
    '  "deadline": "YYYY-MM-DD or empty string if not found",',
    '  "description": "clean job description max 600 words, preserve paragraphs with \\n\\n",',
    '  "sections": ["exact dept name from list above"]',
    '}',
    '',
    'Rules:',
    '- sections must contain ONLY exact names from the list',
    '- Pick 1-3 most relevant departments',
    '- deadline must be YYYY-MM-DD format or empty string',
  ].join('\n');

  const geminiRes = await fetch(
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=' + process.env.GEMINI_API_KEY,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.1 }
      })
    }
  );

  const geminiData = await geminiRes.json();
  console.log('Gemini status:', geminiRes.status);

  const raw = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
  const clean = raw.replace(/```json|```/g, '').trim();
  console.log('Gemini response:', clean);

  let extracted = {};
  try { extracted = JSON.parse(clean); } catch(e) { console.log('Parse error:', e.message); }

  const resolvedSections = (extracted.sections || [])
    .map(deptName => allDepts.find(d => d.dept === deptName))
    .filter(Boolean)
    .map(d => ({ dept: d.dept, section: d.section, group: d.group }));

  if (resolvedSections.length === 0) {
    console.log('No sections matched, defaulting to Vann- og miljøteknikk');
    resolvedSections.push({ dept: 'Vann- og miljøteknikk', section: 'bygg', group: 'be' });
  }

  let jobs = [];
  try { jobs = JSON.parse(fs.readFileSync('jobs.json', 'utf8')); } catch(e) { console.log('jobs.json not found, starting fresh'); }
  jobs = jobs.filter(j => j.id !== id);

  const newJob = {
    id,
    title: extracted.title || 'Ukjent stilling',
    company: extracted.company || '',
    location: extracted.location || 'Norge',
    deadline: extracted.deadline || '',
    desc: extracted.description || '',
    sections: resolvedSections,
    url: url || '',
    posted
  };

  jobs.push(newJob);
  fs.writeFileSync('jobs.json', JSON.stringify(jobs, null, 2));
  console.log('Saved:', newJob.title, '| Depts:', resolvedSections.map(s => s.dept).join(', '));
}

main().catch(e => { console.error(e); process.exit(1); });
