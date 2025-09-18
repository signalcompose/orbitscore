#!/bin/bash

# OrbitScore - Push to signalcompose organization (Private Repository)

echo "🚀 OrbitScore - Push to GitHub (signalcompose organization)"
echo "==========================================================="
echo ""
echo "This will push to: https://github.com/signalcompose/orbitscore"
echo "Repository type: Private"
echo ""

# Check if remote is correctly set
current_remote=$(git remote get-url origin 2>/dev/null)
expected_remote="https://github.com/signalcompose/orbitscore.git"

if [ "$current_remote" != "$expected_remote" ]; then
    echo "Setting correct remote..."
    git remote remove origin 2>/dev/null
    git remote add origin "$expected_remote"
    echo "✓ Remote set to: $expected_remote"
else
    echo "✓ Remote is correctly configured"
fi

echo ""
echo "📝 Please ensure:"
echo "1. You have created a PRIVATE repository at https://github.com/signalcompose/orbitscore"
echo "2. You have push access to the signalcompose organization"
echo "3. You are logged in to GitHub CLI or have credentials configured"
echo ""
echo "To create the repository:"
echo "- Go to: https://github.com/organizations/signalcompose/repositories/new"
echo "- Name: orbitscore"
echo "- Visibility: Private 🔒"
echo "- Description: Music DSL where silence is degree 0 - Revolutionary approach treating rests as musical values"
echo "- DO NOT initialize with README, .gitignore, or license"
echo ""
echo "Press Enter when ready to push..."
read

echo ""
echo "Pushing to GitHub..."
git push -u origin main

if [ $? -eq 0 ]; then
    echo ""
    echo "✅ Successfully pushed to GitHub!"
    echo ""
    echo "Repository URL: https://github.com/signalcompose/orbitscore"
    echo "Visibility: Private 🔒"
    echo ""
    echo "All commits have been pushed:"
    git log --oneline -10
else
    echo ""
    echo "❌ Push failed. Please check:"
    echo ""
    echo "1. Repository exists: https://github.com/signalcompose/orbitscore"
    echo "2. You have push access to signalcompose organization"
    echo "3. Authentication - try one of these:"
    echo "   - GitHub CLI: gh auth login"
    echo "   - Personal Access Token: https://github.com/settings/tokens"
    echo "   - SSH: git remote set-url origin git@github.com:signalcompose/orbitscore.git"
fi