// Scheduler

import bunq = require("./bunq")
import database = require("./database")
import logger = require("anyhow")
import moment = require("moment")
import notifications = require("./notifications")
const settings = require("setmeup").settings

/**
 * Manages scheduled jobs (payments and notifications).
 * Jobs are executed every 5 minutes.
 */
class Scheduler extends require("./base-events") {
    private static _instance: Scheduler
    static get Instance() {
        return this._instance || (this._instance = new this())
    }

    // PROPERTIES
    // --------------------------------------------------------------------------

    /** Timer to fetch jobs from the database. */
    timerCheck: NodeJS.Timer

    // INIT
    // --------------------------------------------------------------------------

    /**
     * Init the Scheduler and start the check timer.
     */
    async init() {
        try {
            const size = database.db.get("scheduler").size()

            // Start the check timer.
            await this.check()
            this.timerCheck = setInterval(this.check, 1000 * 300)

            logger.info("Scheduler.init", `There are ${size} pending scheduled jobs`)
        } catch (ex) {
            logger.error("Scheduler.init", ex)
        }
    }

    /**
     * Check for jobs to be executed. This should once every run every 5 minutes.
     */
    check = async (): Promise<void> => {
        try {
            const filter = job => {
                const jobDate = moment(job.date)
                return jobDate.isBefore(moment())
            }

            const jobFinder = database.db.get("scheduler").filter(filter)
            const jobs: ScheduledJob[] = jobFinder.value()

            if (jobs.length == 0) {
                logger.debug("Scheduler.check", "No jobs to be executed now")
                return
            }

            // Iterate found jobs.
            for (let job of jobs) {
                await this.execute(job)
            }
        } catch (ex) {
            logger.error("Scheduler.check", ex)
        }
    }

    /**
     * Counts how many scheduled jobs are stored on the database.
     * @param job The job to be executed.
     * @event execute
     */
    execute = async (job: ScheduledJob) => {
        try {
            const jobDate = moment(job.date)
            const diff = moment.duration(jobDate.diff(moment()))

            // Remove from database.
            const removed = database.get("scheduler").remove({date: job.date, type: job.type, title: job.title})
            removed.write()

            // Alert or cancel if job is triggered with more than 60 minutes delay,
            // depending on the ignoreDelayed setting.
            if (diff.asMinutes() > 60) {
                if (settings.scheduler.ignoreDelayed) {
                    logger.warn("Scheduler.check", job.type, job.title, `Skipped, was scheduled to run ${diff.humanize(true)}`)
                    return
                }

                logger.warn("Scheduler.check", job.type, job.title, `Delayed trigger, was scheduled to run ${diff.humanize(true)}`)
            }

            // Execute job depending on its type.
            if (job.type == "payment") {
                await bunq.makePayment(job.options as PaymentOptions)
            } else if (job.type == "email") {
                await notifications.toEmail(job.options as EmailNotificationOptions)
            } else if (job.type == "push") {
                await notifications.toPush(job.options as PushNotificationOptions)
            } else {
                throw new Error(`Unsupported job type: ${job.type}`)
            }

            this.emit("execute", job)
        } catch (ex) {
            logger.error("Scheduler.execute", job.type, job.title, job.date, ex)
        }
    }

    /**
     * Add the specified job to the database.
     * @param job The job to be queued and saved to the database.
     * @event queue
     */
    queue = (job: ScheduledJob): void => {
        if (["payment", "email", "push"].indexOf(job.type) < 0) {
            throw new Error(`Unsupported job type: ${job.type}`)
        }

        database.insert("scheduler", job)
        logger.info("Scheduler.queue", job.type, job.title, job.date)
        this.emit("queue", job)
    }
}

// Exports...
export = Scheduler.Instance
