const fs = require('fs');

async function main() {
  const fetch = (await import('node-fetch')).default;

  // Read the pending job file written by the website
  let pending = {};
  try {
    pending = JSON.parse(fs.readFileSync('pending-job.json', 'utf8'));
  } catch(e) {
    console.log('Could not read pending-job.json:', e.message);
    process.exit(1);
  }

  const { url, jobText, id, posted } = pending;
  console.log('Processing job ID:', id);
  console.log('Job text length:', (jobText || '').length);

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

  const promptParts = [
    'You are helping categorize a Norwegian engineering job posting for Oslo Tekniker Samfund, a student engineering organization.',
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
    '  "description": "clean job description max 600 words, preserve paragraphs with \\n\\n, remove irrelevant UI text",',
    '  "sections": ["exact dept name from list above"]',
    '}',
    '',
    'Rules:',
    '- sections must contain ONLY exact names from the list above',
    '- Pick 1-3 most relevant departments based on job content',
    '- deadline must be YYYY-MM-DD format or empty string',
    '- Keep description clean, remove navigation/cookie/footer text',
  ];

  const prompt = promptParts.join('\n');

  console.log('Calling Gemini...');
  const geminiRes = await fetch(
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=' + process.env.GEMINI_API_KEY,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.1 }
      })
    }
  );

  console.log('Gemini HTTP status:', geminiRes.status);
  const geminiData = await geminiRes.json();

  if (geminiData.error) {
    console.log('Gemini error:', JSON.stringify(geminiData.error));
    process.exit(1);
  }

  const raw = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
  console.log('Gemini raw response:', raw.slice(0, 500));

  const clean = raw.replace(/```json|```/g, '').trim();

  let extracted = {};
  try {
    extracted = JSON.parse(clean);
    console.log('Parsed successfully:', extracted.title);
  } catch(e) {
    console.log('JSON parse error:', e.message);
    console.log('Full raw:', raw);
  }

  const resolvedSections = (extracted.sections || [])
    .map(deptName => allDepts.find(d => d.dept === deptName))
    .filter(Boolean)
    .map(d => ({ dept: d.dept, section: d.section, group: d.group }));

  if (resolvedSections.length === 0) {
    console.log('No sections matched from:', extracted.sections);
  }

  let jobs = [];
  try {
    jobs = JSON.parse(fs.readFileSync('jobs.json', 'utf8'));
  } catch(e) {
    console.log('Starting with empty jobs.json');
  }

  // Remove any pending placeholder with same id
  jobs = jobs.filter(j => j.id !== id);

  const newJob = {
    id,
    title: extracted.title || 'Ukjent stilling',
    company: extracted.company || '',
    location: extracted.location || 'Norge',
    deadline: extracted.deadline || '',
    desc: extracted.description || '',
    sections: resolvedSections.length > 0 ? resolvedSections : [{ dept: 'Vann- og miljøteknikk', section: 'bygg', group: 'be' }],
    url: url || '',
    posted
  };

  jobs.push(newJob);
  fs.writeFileSync('jobs.json', JSON.stringify(jobs, null, 2));
  console.log('Saved:', newJob.title, '| Depts:', newJob.sections.map(s => s.dept).join(', '));
}

main().catch(e => { console.error('Fatal error:', e); process.exit(1); });
