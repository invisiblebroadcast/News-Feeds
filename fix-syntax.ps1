$files = Get-ChildItem 'C:\Users\mskmu\Downloads\News-Feeds\js\*.js' | Where-Object { $_.Name -ne 'quote-card-studio.js' }
foreach ($f in $files) {
    $content = Get-Content $f.FullName -Raw
    $original = $content
    # Fix: "if (error)\n    }" -> empty if body
    $content = $content -replace '(?m)if\s*\((?:error|err|rmErr|uploadErr|updErr)\)\s*\r?\n\s*\}', 'if (false) { void 0; }'
    if ($content -ne $original) {
        Set-Content $f.FullName -Value $content -NoNewline
        Write-Host ('Fixed: ' + $f.Name)
    }
}
