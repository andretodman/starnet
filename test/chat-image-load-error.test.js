'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');

const frontend = fs.readFileSync(path.join(__dirname, '../frontend/app/chat.js'), 'utf8');
const website = fs.readFileSync(path.join(__dirname, '../website/app/app/chat.js'), 'utf8');
A.eq(website, frontend, 'website and frontend image viewer stay byte-identical');
A.ok(/const e = new Error\('file HTTP ' \+ r\.status\); e\.status = r\.status; throw e;/.test(frontend),
  'file fetch preserves the HTTP status for image-view diagnosis');
A.ok(/status === 401[\s\S]{0,800}status === 403[\s\S]{0,800}status === 404[\s\S]{0,800}status === 502 \|\| status === 503/.test(frontend),
  'image viewer distinguishes expired sessions, denied paths, missing files and transfer failures');
A.ok(/\.catch\(error => \{[\s\S]{0,220}StationUI\.notify\(imageLoadFailureMessage\(error\), 'warn'\)/.test(frontend),
  'lightbox reports the specific mapped image failure instead of blaming an unreachable sidecar');
A.ok(!frontend.includes('could not load that image — the sidecar may be unreachable'),
  'misleading generic sidecar warning is removed');
A.report('chat-image-load-error.test');
