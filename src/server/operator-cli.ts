#!/usr/bin/env node

import { runOperatorAdmin } from './operator-admin'

process.exitCode = await runOperatorAdmin(process.argv.slice(2))
