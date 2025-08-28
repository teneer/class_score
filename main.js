// Supabase API 키와 URL을 여기에 넣으세요
const SUPABASE_URL = 'YOUR_SUPABASE_URL';
const SUPABASE_ANON_KEY = 'YOUR_SUPABASE_ANON_KEY';

const { createClient } = supabase;
const _supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// 모둠 목록 (예시)
const teams = [
    { id: 1, name: '1 모둠' },
    { id: 2, name: '2 모둠' },
    { id: 3, name: '3 모둠' },
];

async function fetchScores() {
    const { data: scores, error } = await _supabase
        .from('scores')
        .select('*');

    if (error) {
        console.error('Error fetching scores:', error);
        return [];
    }
    return scores;
}

async function updateScore(teamId, newScore) {
    const { data, error } = await _supabase
        .from('scores')
        .update({ score: newScore })
        .eq('id', teamId);
    
    if (error) {
        console.error('Error updating score:', error);
    }
}

async function renderScores() {
    const scores = await fetchScores();
    const scoresContainer = document.getElementById('scores-container');
    scoresContainer.innerHTML = '';

    teams.forEach(team => {
        const teamScore = scores.find(s => s.id === team.id) || { score: 0 };
        const teamCard = document.createElement('div');
        teamCard.className = 'team-card';
        teamCard.innerHTML = `
            <div class="team-name">${team.name}</div>
            <div class="score">${teamScore.score}</div>
            <div class="buttons">
                <button class="add-btn" onclick="modifyScore(${team.id}, 1)">👍</button>
                <button class="subtract-btn" onclick="modifyScore(${team.id}, -1)">👎</button>
            </div>
        `;
        scoresContainer.appendChild(teamCard);
    });
}

async function modifyScore(teamId, change) {
    const scores = await fetchScores();
    const teamScore = scores.find(s => s.id === teamId);
    if (teamScore) {
        const newScore = teamScore.score + change;
        await updateScore(teamId, newScore);
        renderScores();
    }
}

document.addEventListener('DOMContentLoaded', () => {
    // Supabase JS 라이브러리 추가
    const script = document.createElement('script');
    script.src = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2";
    script.onload = renderScores;
    document.head.appendChild(script);
});