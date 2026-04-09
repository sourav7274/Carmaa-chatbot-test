import mongoose from 'mongoose';
const { Schema } = mongoose;

const bookingSchema = new Schema(
  {
    customer_id: {
      type: Schema.Types.ObjectId,
      ref: 'user',
    },
    remarks: String,
    booking_type: String,
    sub_type: {
      type: String,
      enum: ['quick_wash', 'specific'],
      default: 'specific',
    },
    assign_to: {
      type: Schema.Types.ObjectId,
      ref: 'employee',
    },
    feedback: [
      {
        question: String,
        rating: Number,
        remarks: String,
      },
    ],
    rating: [
      {
        service_name: String,
        service_id: {
          type: Schema.Types.ObjectId,
          ref: 'service',
        },
        rating: Number,
        remarks: String,
      },
    ],
    subscription_id: String,
    status: String, // not_picked ,to do, completed,in progress, cancelled,testing,blocker,
    time: String,
    date: String,
    address: {
      type: Schema.Types.Mixed,
      latitude: String,
      longitude: String,
      region_id:
        {
          type: Schema.Types.ObjectId,
          ref: 'city',
        },
    },
    service: [
      {
        vehicle: {
          type: Schema.Types.ObjectId,
          ref: 'car',
        },
        service: {
          type: Schema.Types.ObjectId,
          ref: 'service',
        },
        addOns: [
          {
            type: Schema.Types.ObjectId,
            ref: 'service',
          },
        ],
        feedback: {
          rating: String,
          comment: String,
        },
      },
    ],
    payment: {
      price: String,
      discount: String,
      method: String,
      wallet_amount: String,
      paid: String,
      paidOn: String,
      transaction_id: String,
      status: String,
      other_charges: [{ name: String, amount: Number }],
      razorpay_order_id: String,
      coupon: {
        type: Schema.Types.ObjectId,
        ref: 'coupon_code',
      },
    },
    bill_details: {
      booked_services: [
        {
          user_vehicle_id: {
            type: Schema.Types.ObjectId,
          },
          vehicle: {
            type: Schema.Types.ObjectId,
            ref: 'car',
          },
          services: [
            {
              id: {
                type: Schema.Types.ObjectId,
                ref: 'service',
              },
              service_name: String,
              addOns: [
                {
                  id: {
                    type: Schema.Types.ObjectId,
                    ref: 'service',
                  },
                  name: String,
                  price: String,
                  discount: String,
                },
              ],
              price: String,
              discount: String,
            },
          ],
        },
      ],
      coupons: [
        {
          code: String,
          coupon_id: {
            type: Schema.Types.ObjectId,
            ref: 'coupon_code',
          },
          discount: String,
          discountPercentage: Number,
        },
      ],
    },
    mall_data: {
      type: Schema.Types.Mixed,
      default: {},
    },
    created_by: {
      type: Schema.Types.ObjectId,
      ref: 'employee',
    },
    updated_by: {
      type: Schema.Types.ObjectId,
      ref: 'employee',
    },
    assignee: {
      name: String,
      mobile_number: Number,
      worker_id: String,
    },
    location: {
      latitude: String,
      longitude: String,
    },
    order_id: String,
    subscription_dates: [
      {
        date: String,
        time: String,
        status: { type: String, default: 'to do' },
        assignee: {
          name: String,
          mobile_number: Number,
          worker_id: String,
        },
        feedback: [
          {
            question: String,
            rating: Number,
            remarks: String,
          },
        ],
        rating: [
          {
            service_name: String,
            service_id: {
              type: Schema.Types.ObjectId,
              ref: 'service',
            },
            rating: Number,
            remarks: String,
          },
        ],
        customer_rating: {
          rating: String,
          comment: String,
        },
      },
    ],
  },
  { timestamps: true },
);

export const Booking = mongoose.model('booking', bookingSchema);
