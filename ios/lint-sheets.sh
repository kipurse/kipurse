#!/bin/sh
# Regression lint: a sheet/alert item must not be built with a fresh UUID inside a Binding getter (causes re-present loops).
if grep -nE 'Binding\(get: *\{[^}]*UUID\(\)' App/Sources/*.swift; then echo "FAIL: UUID() inside Binding(get:)"; exit 1; fi
if grep -nE 'Binding\(get:[^)]*\.map *\{ *[A-Z][A-Za-z]*\(v:' App/Sources/*.swift; then echo "FAIL: wrapper object created in Binding getter"; exit 1; fi
echo "sheet lint OK"
