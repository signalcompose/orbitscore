#!/bin/bash

# OrbitScore - Push to GitHub Script
# This script will help you push your code to GitHub

echo "🚀 OrbitScore - Push to GitHub"
echo "=============================="
echo ""

# Check if remote exists
if git remote | grep -q origin; then
    echo "Remote 'origin' already exists. Removing..."
    git remote remove origin
fi

echo "Please enter your GitHub username:"
read GITHUB_USERNAME

echo ""
echo "Setting up remote for: https://github.com/${GITHUB_USERNAME}/orbitscore.git"
git remote add origin "https://github.com/${GITHUB_USERNAME}/orbitscore.git"

echo ""
echo "Creating repository on GitHub (if it doesn't exist)..."
echo "Please make sure you're logged in to GitHub."
echo ""
echo "You can create the repository at: https://github.com/new"
echo "Repository name: orbitscore"
echo "Description: A new music DSL independent of LilyPond with TidalCycles-style execution"
echo "Make it public or private as you prefer"
echo ""
echo "Press Enter when the repository is created..."
read

echo ""
echo "Pushing to GitHub..."
git push -u origin main

if [ $? -eq 0 ]; then
    echo ""
    echo "✅ Successfully pushed to GitHub!"
    echo "Your repository is now available at: https://github.com/${GITHUB_USERNAME}/orbitscore"
else
    echo ""
    echo "❌ Push failed. Please check:"
    echo "1. The repository exists on GitHub"
    echo "2. You have the correct permissions"
    echo "3. Your GitHub credentials are configured"
    echo ""
    echo "You can configure credentials with:"
    echo "git config --global user.name 'Your Name'"
    echo "git config --global user.email 'your.email@example.com'"
fi