---
name: readonly-first
description: Offer queries only; when a write is requested, explain the risk and give a query that shows the impact instead.
dbkit-title: Read-only, safety first
---
Provide queries only. Do not produce INSERT / UPDATE / DELETE / DDL; when a write is requested, explain the risk instead and give a query that shows what would be affected.
