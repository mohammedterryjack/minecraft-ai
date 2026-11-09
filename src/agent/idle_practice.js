// SkillWeaver-style idle practice (after https://arxiv.org/abs/2504.07079)
// When the agent is idle (no active task, between curriculum picks), proposes
// small practice skill goals, attempts them with the free/local path, and
// promotes successful ones to the skill library.

import { readFileSync, existsSync, mkdirSync } from 'fs';
import { writeAtomic } from './voyager.js';

const MIN_IDLE_MS = 30000;
const PRACTICE_COOLDOWN_MS = 5 * 60 * 1000;
const MAX_PRACTICE_LOG = 100;

export class IdlePractice {
    constructor(botName) {
        this.botName = botName;
        this.dir = `./bots/${botName}`;
        this.file = `${this.dir}/idle_practice.json`;
        mkdirSync(this.dir, { recursive: true });
        this._load();
        this.idleSince = null;
        this.practiceInProgress = false;
    }

    _load() {
        try {
            if (existsSync(this.file)) {
                const data = JSON.parse(readFileSync(this.file, 'utf8'));
                this.practiceLog = data.practiceLog || [];
                this.lastPractice = data.lastPractice || 0;
                this.gaps = data.gaps || [];
                this.enabled = data.enabled !== false;
                console.log(`[idle-practice] loaded ${this.practiceLog.length} practice entries, ${this.gaps.length} known gaps`);
            } else {
                this.practiceLog = [];
                this.lastPractice = 0;
                this.gaps = [];
                this.enabled = true;
                console.log(`[idle-practice] initialized empty practice state`);
            }
        } catch (e) {
            throw new Error(`[idle-practice] FAILED to load ${this.file}: ${e.message}`);
        }
    }

    _save() {
        try {
            writeAtomic(this.file, JSON.stringify({
                practiceLog: this.practiceLog,
                lastPractice: this.lastPractice,
                gaps: this.gaps,
                enabled: this.enabled,
            }, null, 2));
        } catch (e) {
            throw new Error(`[idle-practice] FAILED to persist to ${this.file}: ${e.message}`);
        }
    }

    setEnabled(v) {
        this.enabled = !!v;
        this._save();
        console.log(`[idle-practice] ${this.enabled ? 'enabled' : 'disabled'}`);
    }

    markIdle() {
        if (!this.idleSince) {
            this.idleSince = Date.now();
        }
    }

    markBusy() {
        this.idleSince = null;
    }

    isReadyForPractice(hasRepairQueue, hasPendingTask) {
        if (!this.enabled) return { ready: false, reason: 'practice disabled' };
        if (this.practiceInProgress) return { ready: false, reason: 'practice already in progress' };
        if (!this.idleSince) return { ready: false, reason: 'not idle' };
        if (hasRepairQueue) return { ready: false, reason: 'repair queue not empty' };
        if (hasPendingTask) return { ready: false, reason: 'pending task exists' };
        
        const idleMs = Date.now() - this.idleSince;
        if (idleMs < MIN_IDLE_MS) {
            return { ready: false, reason: `idle for ${Math.round(idleMs / 1000)}s (need ${MIN_IDLE_MS / 1000}s)` };
        }
        
        const sinceLast = Date.now() - this.lastPractice;
        if (sinceLast < PRACTICE_COOLDOWN_MS) {
            return { ready: false, reason: `cooldown: ${Math.round((PRACTICE_COOLDOWN_MS - sinceLast) / 1000)}s remaining` };
        }
        
        return { ready: true };
    }

    recordGap(task, reason) {
        if (!task) return;
        const key = String(task).toLowerCase();   // fix96: the whole task (a cut key became a cut practice goal)
        const existing = this.gaps.find(g => g.task === key);
        if (existing) {
            existing.count++;
            existing.lastSeen = Date.now();
            existing.reason = String(reason || existing.reason);
        } else {
            this.gaps.push({
                task: key,
                reason: String(reason || ''),
                count: 1,
                firstSeen: Date.now(),
                lastSeen: Date.now(),
            });
        }
        this.gaps = this.gaps
            .sort((a, b) => b.count - a.count)
            .slice(0, 50);
        this._save();
    }

    recordWeakSkill(skillName, failRate) {
        if (!skillName || failRate < 0.3) return;
        const key = `improve_skill_${skillName}`;
        const existing = this.gaps.find(g => g.task === key);
        if (existing) {
            existing.count++;
            existing.lastSeen = Date.now();
            existing.reason = `fail rate ${Math.round(failRate * 100)}%`;
        } else {
            this.gaps.push({
                task: key,
                reason: `fail rate ${Math.round(failRate * 100)}%`,
                count: 1,
                firstSeen: Date.now(),
                lastSeen: Date.now(),
                isSkillPractice: true,
                skillName,
            });
        }
        this._save();
    }

    recordMissingProducer(item) {
        if (!item) return;
        const key = `learn_to_produce_${item}`;
        const existing = this.gaps.find(g => g.task === key);
        if (existing) {
            existing.count++;
            existing.lastSeen = Date.now();
        } else {
            this.gaps.push({
                task: key,
                reason: `no learned skill produces ${item}`,
                count: 1,
                firstSeen: Date.now(),
                lastSeen: Date.now(),
                isProducerGap: true,
                item,
            });
        }
        this._save();
    }

    proposePracticeGoal(skills, npGraph, failedTasks) {
        const candidates = [];
        
        for (const gap of this.gaps) {
            if (gap.isSkillPractice && gap.skillName) {
                const skill = skills.find(s => s.name === gap.skillName && !s.demoted);
                if (skill) {
                    candidates.push({
                        type: 'skill_practice',
                        goal: `practice ${gap.skillName} until it works reliably`,
                        skill: gap.skillName,
                        priority: gap.count * 2,
                    });
                }
            } else if (gap.isProducerGap && gap.item) {
                candidates.push({
                    type: 'producer_gap',
                    goal: `learn a way to produce ${gap.item}`,
                    item: gap.item,
                    priority: gap.count,
                });
            } else {
                const recentFail = failedTasks?.includes(gap.task);
                if (!recentFail) {
                    candidates.push({
                        type: 'retry_failed',
                        goal: gap.task,
                        priority: gap.count * 0.5,
                    });
                }
            }
        }
        
        const weakSkills = skills
            .filter(s => !s.demoted && !s.mergedInto && s.stats)
            .map(s => {
                const total = (s.stats.success || 0) + (s.stats.fail || 0);
                const failRate = total > 2 ? (s.stats.fail || 0) / total : 0;
                return { skill: s, failRate };
            })
            .filter(x => x.failRate > 0.4)
            .sort((a, b) => b.failRate - a.failRate);
        
        for (const { skill, failRate } of weakSkills.slice(0, 3)) {
            const alreadyTracked = candidates.some(c => c.skill === skill.name);
            if (!alreadyTracked && skill.task) {
                candidates.push({
                    type: 'weak_skill',
                    goal: skill.task,
                    skill: skill.name,
                    priority: failRate * 3,
                });
            }
        }
        
        if (!candidates.length) {
            console.log(`[idle-practice] no practice candidates found`);
            return null;
        }
        
        candidates.sort((a, b) => b.priority - a.priority);
        const pick = candidates[0];
        console.log(`[idle-practice] proposed: ${pick.goal} (type: ${pick.type}, priority: ${pick.priority.toFixed(1)})`);
        return pick;
    }

    startPractice(goal) {
        this.practiceInProgress = true;
        this.currentPractice = {
            goal,
            startedAt: Date.now(),
        };
    }

    endPractice(outcome, skillLearned) {
        this.practiceInProgress = false;
        this.lastPractice = Date.now();
        
        const entry = {
            goal: this.currentPractice?.goal?.goal || 'unknown',
            type: this.currentPractice?.goal?.type || 'unknown',
            outcome: outcome ? 'success' : 'failure',
            skillLearned: skillLearned || null,
            duration: Date.now() - (this.currentPractice?.startedAt || Date.now()),
            timestamp: new Date().toISOString(),
        };
        
        this.practiceLog.unshift(entry);
        if (this.practiceLog.length > MAX_PRACTICE_LOG) {
            this.practiceLog = this.practiceLog.slice(0, MAX_PRACTICE_LOG);
        }
        
        if (outcome && this.currentPractice?.goal) {
            const goalKey = String(this.currentPractice.goal.goal || '').toLowerCase();
            this.gaps = this.gaps.filter(g => g.task !== goalKey);
        }
        
        this.currentPractice = null;
        this._save();
        
        const outcomeStr = outcome ? 'SUCCESS' : 'FAILURE';
        console.log(`[idle-practice] practice ${outcomeStr}: ${entry.goal}${skillLearned ? ` (learned: ${skillLearned})` : ''}`);
        
        if (!outcome) {
            throw new Error(`[idle-practice] practice FAILED: ${entry.goal}`);
        }
    }

    getPracticeStats() {
        const total = this.practiceLog.length;
        const successes = this.practiceLog.filter(p => p.outcome === 'success').length;
        const skillsLearned = this.practiceLog.filter(p => p.skillLearned).length;
        return {
            total,
            successes,
            successRate: total ? (successes / total).toFixed(2) : '0.00',
            skillsLearned,
        };
    }
}
